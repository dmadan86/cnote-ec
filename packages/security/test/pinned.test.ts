import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.fn();
vi.mock("node:dns/promises", () => ({ lookup: (...a: unknown[]) => lookup(...a) }));

const { assertPublicHttpTarget, assertPublicHttpUrl, pinnedFetch, pinnedLookup } = await import("../src");

let server: Server;
let port = 0;
let seenHost = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    seenHost = String(req.headers.host);
    if (req.url === "/empty") { res.writeHead(204).end(); return; }
    if (req.url === "/big") { res.writeHead(200).end(Buffer.alloc(6 * 1024 * 1024, 1)); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://169.254.169.254/" }).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => lookup.mockReset());

describe("DNS pinning (SSRF TOCTOU)", () => {
  it("resolves exactly once and returns the validated address", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const t = await assertPublicHttpTarget("https://example.com/x");
    expect(t).toMatchObject({ address: "93.184.216.34", family: 4 });
    expect(lookup).toHaveBeenCalledTimes(1);
    await assertPublicHttpUrl("https://example.com/x");
    expect(lookup).toHaveBeenCalledTimes(2); // the URL-only form delegates to the target form, one lookup per call
  });

  it("rejects when ANY answer is private (rebinding answer sets) and never returns a target", async () => {
    lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(assertPublicHttpTarget("https://rebind.example.com")).rejects.toThrow("not allowed");
    lookup.mockResolvedValue([{ address: "::ffff:10.0.0.1", family: 6 }]);
    await expect(assertPublicHttpTarget("https://v6.example.com")).rejects.toThrow("not allowed");
  });

  it("connects to the pinned IP, not to whatever the hostname resolves to later", async () => {
    // the hostname does not exist in DNS: a normal fetch would fail; the pinned fetch must reach 127.0.0.1 regardless
    const res = await pinnedFetch({ url: new URL(`http://pinned.invalid:${port}/x`), address: "127.0.0.1", family: 4 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seenHost).toBe(`pinned.invalid:${port}`); // Host header keeps the original name
  });

  it("does not follow redirects (the target would be unvalidated)", async () => {
    const res = await pinnedFetch({ url: new URL(`http://pinned.invalid:${port}/redirect`), address: "127.0.0.1", family: 4 });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://169.254.169.254/");
  });

  it("handles empty (204) bodies and refuses oversized bodies", async () => {
    const empty = await pinnedFetch({ url: new URL(`http://pinned.invalid:${port}/empty`), address: "127.0.0.1", family: 4 });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    await expect(pinnedFetch({ url: new URL(`http://pinned.invalid:${port}/big`), address: "127.0.0.1", family: 4 })).rejects.toThrow(/too large/);
  });

  it("honours a caller-supplied abort signal and a custom timeout", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(pinnedFetch({ url: new URL(`http://pinned.invalid:${port}/x`), address: "127.0.0.1", family: 4 }, { signal: ctl.signal })).rejects.toThrow();
    const ok = await pinnedFetch({ url: new URL(`http://pinned.invalid:${port}/x`), address: "127.0.0.1", family: 4 }, { timeoutMs: 5000, headers: { accept: "application/json" } });
    expect(ok.status).toBe(200);
  });

  it("the custom lookup answers in both single and `all` shapes", () => {
    const l = pinnedLookup("203.0.113.9", 4);
    l("x", { all: true }, (e, a) => expect(a).toEqual([{ address: "203.0.113.9", family: 4 }]));
    l("x", {}, (e, a, f) => { expect(a).toBe("203.0.113.9"); expect(f).toBe(4); });
  });
});
