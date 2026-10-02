// Bounded multipart uploads (security audit: lower the global server-action body limit; big uploads move to route handlers with caps).
import { DomainError } from "@cnote/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBoundedFormData } from "../src/upload";
import { hasFileEntries, submitFormAsAction } from "../src/upload-client";

const MB = 1024 * 1024;

async function asBytes(req: Request) {
  const buf = new Uint8Array(await req.arrayBuffer());
  return { buf, type: req.headers.get("content-type")! };
}
async function realRequest(files: Record<string, number>, headers: Record<string, string> = {}): Promise<Request> {
  const fd = new FormData();
  fd.set("title", "hello");
  for (const [name, size] of Object.entries(files)) fd.append("attachments", new File([new Uint8Array(size).fill(1)], name, { type: "application/pdf" }));
  const { buf, type } = await asBytes(new Request("http://localhost/x", { method: "POST", body: fd }));
  return new Request("http://localhost/api/rfq", { method: "POST", headers: { "content-type": type, "content-length": String(buf.length), ...headers }, body: buf });
}

describe("readBoundedFormData", () => {
  it("parses a multipart body under the cap", async () => {
    const form = await readBoundedFormData(await realRequest({ "a.pdf": 1000 }), 1 * MB);
    expect(form.get("title")).toBe("hello");
    expect((form.get("attachments") as File).size).toBe(1000);
  });

  it("rejects a declared Content-Length over the cap before reading the body", async () => {
    await expect(readBoundedFormData(await realRequest({ "a.pdf": 2 * MB }), 1 * MB)).rejects.toThrow(/too large/);
  });

  it("enforces the cap on bytes actually received when Content-Length understates the body", async () => {
    const req = await realRequest({ "a.pdf": 2 * MB }, { "content-length": "5000" });
    await expect(readBoundedFormData(req, 1 * MB)).rejects.toThrow(/too large/);
  });

  it("rejects missing/invalid Content-Length, non-multipart bodies and cross-site posts", async () => {
    const noLen = await realRequest({ "a.pdf": 10 }, { "content-length": "" });
    await expect(readBoundedFormData(noLen, MB)).rejects.toThrow(/size was not declared/);
    const json = new Request("http://localhost/api/rfq", { method: "POST", headers: { "content-type": "application/json", "content-length": "2" }, body: "{}" });
    await expect(readBoundedFormData(json, MB)).rejects.toThrow(/Expected a form upload/);
    await expect(readBoundedFormData(await realRequest({ "a.pdf": 10 }, { origin: "https://evil.example" }), MB)).rejects.toMatchObject({ code: "forbidden" });
    const empty = new Request("http://localhost/api/rfq", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=x", "content-length": "10" } });
    await expect(readBoundedFormData(empty, MB)).rejects.toBeInstanceOf(DomainError);
  });

  it("a malformed multipart body is a validation error, not a crash", async () => {
    const bad = new Request("http://localhost/api/rfq", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=zzz", "content-length": "9" }, body: "not-multi!" });
    await expect(readBoundedFormData(bad, MB)).rejects.toMatchObject({ code: "validation" });
  });
});

describe("hasFileEntries", () => {
  it("ignores text fields and the empty entry an untouched file input submits", () => {
    const fd = new FormData();
    fd.set("a", "b");
    fd.append("files", new File([], "", { type: "application/octet-stream" }));
    expect(hasFileEntries(fd)).toBe(false);
    fd.append("files", new File([new Uint8Array(3)], "x.png"));
    expect(hasFileEntries(fd)).toBe(true);
  });
});

describe("submitFormAsAction", () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("returns the data on success and follows a redirect", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { ok: true, data: { created: "d1" }, redirect: "/buyer/disputes/d1" })));
    expect(await submitFormAsAction("/api/disputes", new FormData())).toEqual({ ok: true, data: { created: "d1" } });
    expect(assign).toHaveBeenCalledWith("/buyer/disputes/d1");
  });

  it("maps errorResponse bodies (message, key, params) and zod issues to an ActionResult failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(422, { error: "Too big", code: "validation", key: "x.y", params: { max: 5 } })));
    expect(await submitFormAsAction("/u", new FormData())).toEqual({ ok: false, error: "Too big", errorKey: "x.y", errorParams: { max: 5 } });
    vi.stubGlobal("fetch", vi.fn(async () => json(422, { error: "validation", issues: [{ path: ["price"], message: "Enter a price" }, { path: ["price"], message: "dup" }] })));
    expect(await submitFormAsAction("/u", new FormData())).toMatchObject({ ok: false, fieldErrors: { price: "Enter a price" } });
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { error: "bad", fieldErrors: { a: "b" } })));
    expect(await submitFormAsAction("/u", new FormData())).toMatchObject({ ok: false, fieldErrors: { a: "b" } });
  });

  it("falls back to friendly messages for 413, 500 and unparsable bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 413 })));
    expect(await submitFormAsAction("/u", new FormData())).toMatchObject({ ok: false, error: "The upload is too large." });
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "internal" })));
    expect(await submitFormAsAction("/u", new FormData())).toMatchObject({ ok: false, error: expect.stringMatching(/Something went wrong/) });
  });

  it("a network failure is reported, not thrown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    expect(await submitFormAsAction("/u", new FormData())).toMatchObject({ ok: false, error: expect.stringMatching(/Network error/) });
  });

  it("retries once after refreshing the session when the first answer is 401", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      if (url === "/api/me") return json(200, {});
      return calls.filter((c) => c === "/api/rfq").length === 1 ? json(401, { error: "Please sign in again." }) : json(201, { ok: true, data: 7 });
    }));
    expect(await submitFormAsAction<number>("/api/rfq", new FormData(), { refreshUrl: "/api/me" })).toEqual({ ok: true, data: 7 });
    expect(calls).toEqual(["/api/rfq", "/api/me", "/api/rfq"]);
  });
});
