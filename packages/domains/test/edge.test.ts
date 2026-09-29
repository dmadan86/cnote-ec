import { afterEach, describe, expect, it } from "vitest";
import { AwsEdgeProvider, CloudflareEdgeProvider, createEdgeProvider, getEdgeProvider, MockEdgeProvider, setEdgeProvider, VercelEdgeProvider } from "../src/edge";

type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (c: Call) => { status?: number; body?: unknown; raw?: string }) {
  const calls: Call[] = [];
  const f = async (url: string, init: RequestInit = {}) => {
    const c = { url, init };
    calls.push(c);
    const r = handler(c);
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
  };
  return { f, calls };
}

describe("MockEdgeProvider", () => {
  it("activates immediately, idempotent, delete, unknown -> failed", async () => {
    const m = new MockEdgeProvider();
    const a = await m.createCustomHostname("a.com");
    const b = await m.createCustomHostname("a.com");
    expect(a).toEqual(b);
    expect(a.status.state).toBe("active");
    m.set("a.com", { state: "pending" });
    expect((await m.getStatus(a.ref)).state).toBe("pending");
    await m.delete(a.ref);
    expect((await m.getStatus(a.ref)).state).toBe("failed");
  });
});

describe("factory", () => {
  afterEach(() => setEdgeProvider(undefined));
  it("maps names to providers (default mock)", () => {
    expect(createEdgeProvider("cloudflare").name).toBe("cloudflare");
    expect(createEdgeProvider("vercel").name).toBe("vercel");
    expect(createEdgeProvider("aws").name).toBe("aws");
    expect(createEdgeProvider("whatever").name).toBe("mock");
    expect(createEdgeProvider().name).toBe("mock");
  });
  it("getEdgeProvider is a memoised singleton, overridable", () => {
    setEdgeProvider(undefined);
    expect(getEdgeProvider()).toBe(getEdgeProvider());
    const m = new MockEdgeProvider();
    setEdgeProvider(m);
    expect(getEdgeProvider()).toBe(m);
  });
});

describe("AwsEdgeProvider (documented stub)", () => {
  it("every operation throws a clear not-implemented error", async () => {
    const a = new AwsEdgeProvider();
    await expect(a.createCustomHostname("x.com")).rejects.toThrow(/not implemented/);
    await expect(a.getStatus("r")).rejects.toThrow(/not implemented/);
    await expect(a.delete("r")).rejects.toThrow(/not implemented/);
    expect(a.caaIssuers).toContain("amazon.com");
  });
});

describe("CloudflareEdgeProvider", () => {
  const cf = (h: Parameters<typeof fakeFetch>[0]) => { const ff = fakeFetch(h); return { p: new CloudflareEdgeProvider("tok", "zone1", ff.f), calls: ff.calls }; };
  const res = (o: object = {}) => ({ id: "h1", hostname: "a.com", status: "pending", ...o });

  it("requires credentials", async () => {
    await expect(new CloudflareEdgeProvider("", "", (async () => new Response("{}")) as never).getStatus("x")).rejects.toThrow(/CF_API_TOKEN/);
  });
  it("toStatus mapping table", () => {
    const s = CloudflareEdgeProvider.toStatus;
    expect(s(res({ status: "active", ssl: { status: "active" } })).state).toBe("active");
    expect(s(res({ status: "active", ssl: { status: "pending_validation" } })).state).toBe("pending");
    expect(s(res({ status: "pending" })).state).toBe("pending");
    for (const st of ["blocked", "moved", "deleted"]) expect(s(res({ status: st })).state).toBe("failed");
    for (const ssl of ["deleted", "validation_timed_out", "issuance_timed_out", "deactivating"]) expect(s(res({ status: "active", ssl: { status: ssl } })).state).toBe("failed");
    expect(s(res({ status: "blocked" })).error).toBe("Cloudflare reported blocked/");
    const withErr = s(res({ status: "pending", verification_errors: ["dns not found"], ssl: { validation_errors: [{ message: "caa" }] } }));
    expect(withErr.error).toBe("dns not found");
    expect(s(res({ ssl: { validation_errors: [{ message: "caa" }] } })).error).toBe("caa");
  });
  it("toStatus surfaces ownership TXT and DCV records", () => {
    const r = CloudflareEdgeProvider.toStatus(res({ ownership_verification: { type: "txt", name: "_cf.a.com", value: "v1" }, ssl: { validation_records: [{ txt_name: "_acme.a.com", txt_value: "v2" }, { http_url: "x" }] } }));
    expect(r.records).toEqual([
      { type: "TXT", name: "_cf.a.com", value: "v1", purpose: "ownership" },
      { type: "TXT", name: "_acme.a.com", value: "v2", purpose: "ownership" },
    ]);
    expect(CloudflareEdgeProvider.toStatus(res({ ownership_verification: { type: "http", name: "n", value: "v" } })).records).toEqual([]);
  });
  it("create: POST with bearer auth and returns ref", async () => {
    const { p, calls } = cf(() => ({ body: { success: true, result: res({ id: "abc" }) } }));
    const r = await p.createCustomHostname("a.com");
    expect(r.ref).toBe("abc");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ hostname: "a.com", ssl: { method: "http" } });
  });
  it("create: duplicate (1406) adopts existing; otherwise throws with details", async () => {
    let n = 0;
    const { p, calls } = cf((c) => (n++ === 0 ? { status: 400, body: { success: false, errors: [{ code: 1406, message: "dup" }], result: null } } : { body: { success: true, result: [res({ id: "old" })] } }));
    expect((await p.createCustomHostname("a.com")).ref).toBe("old");
    expect(calls[1]!.url).toContain("?hostname=a.com");
    const dupNotFound = cf(() => ({ body: { success: false, errors: [{ code: 1406, message: "dup" }], result: [] } }));
    await expect(dupNotFound.p.createCustomHostname("a.com")).rejects.toThrow(/1406 dup/);
    const other = cf(() => ({ status: 500, raw: "oops" }));
    await expect(other.p.createCustomHostname("a.com")).rejects.toThrow(/unknown error/);
  });
  it("getStatus: 404 -> failed, error -> throws, ok -> mapped", async () => {
    expect(await cf(() => ({ status: 404, body: { success: false, result: null } })).p.getStatus("r")).toMatchObject({ state: "failed" });
    await expect(cf(() => ({ status: 500, body: { success: false, errors: [{ code: 1, message: "boom" }], result: null } })).p.getStatus("r")).rejects.toThrow(/boom/);
    await expect(cf(() => ({ status: 502, body: { success: true, result: [] } })).p.getStatus("r")).rejects.toThrow(/502/);
    expect((await cf(() => ({ body: { success: true, result: res({ status: "active", ssl: { status: "active" } }) } })).p.getStatus("r/1")).state).toBe("active");
  });
  it("delete: 404 tolerated, failure throws, ref URL-encoded", async () => {
    const a = cf(() => ({ status: 404, body: { success: false } }));
    await a.p.delete("r/1");
    expect(a.calls[0]!.url).toContain("/r%2F1");
    await expect(cf(() => ({ status: 500, body: { success: false, errors: [{ code: 1, message: "no" }] } })).p.delete("r")).rejects.toThrow(/no/);
    await cf(() => ({ body: { success: true } })).p.delete("r");
  });
});

describe("VercelEdgeProvider", () => {
  const vc = (h: Parameters<typeof fakeFetch>[0], team = "") => { const ff = fakeFetch(h); return { p: new VercelEdgeProvider("tok", "prj", team, ff.f), calls: ff.calls }; };
  it("requires credentials", async () => {
    await expect(new VercelEdgeProvider("", "", "", (async () => new Response("{}")) as never).getStatus("x")).rejects.toThrow(/VERCEL_TOKEN/);
  });
  it("adds teamId with ? or & correctly", async () => {
    const a = vc(() => ({ body: { name: "a.com", verified: true } }), "team 1");
    await a.p.delete("a.com");
    expect(a.calls[0]!.url).toBe("https://api.vercel.com/v9/projects/prj/domains/a.com?teamId=team%201");
  });
  it("create: verified + config ok -> active; misconfigured -> pending; unverified -> pending with TXT", async () => {
    const active = vc((c) => (c.url.includes("/config") ? { body: { misconfigured: false } } : { body: { name: "a.com", verified: true } }));
    expect(await active.p.createCustomHostname("a.com")).toMatchObject({ ref: "a.com", status: { state: "active" } });
    const mis = vc((c) => (c.url.includes("/config") ? { body: { misconfigured: true } } : { body: { name: "a.com", verified: true } }));
    expect((await mis.p.createCustomHostname("a.com")).status.state).toBe("pending");
    const un = vc(() => ({ body: { name: "a.com", verified: false, verification: [{ type: "TXT", domain: "_vercel.a.com", value: "vc-domain-verify=x", reason: "pending_domain_verification" }, { type: "CNAME", domain: "y", value: "z" }] } }));
    const r = await un.p.createCustomHostname("a.com");
    expect(r.status).toMatchObject({ state: "pending", detail: "unverified", error: "pending_domain_verification" });
    expect(r.status.records).toEqual([{ type: "TXT", name: "_vercel.a.com", value: "vc-domain-verify=x", purpose: "ownership" }]);
  });
  it("create: already in use is adopted (409 / error code), other errors throw", async () => {
    const a = vc((c) => (c.init.method === "POST" ? { status: 409, body: { error: { code: "domain_already_in_use" } } } : c.url.includes("/config") ? { body: {} } : { body: { name: "a.com", verified: true } }));
    expect((await a.p.createCustomHostname("a.com")).status.state).toBe("active");
    const b = vc((c) => (c.init.method === "POST" ? { status: 409, body: {} } : { status: 404, body: {} }));
    await expect(b.p.createCustomHostname("a.com")).rejects.toThrow(/Vercel add domain failed: 409/);
    const c = vc(() => ({ status: 403, body: { error: { message: "forbidden" } } }));
    await expect(c.p.createCustomHostname("a.com")).rejects.toThrow(/forbidden/);
    const d = vc(() => ({ status: 200, body: { error: { message: "in body" } } }));
    await expect(d.p.createCustomHostname("a.com")).rejects.toThrow(/in body/);
  });
  it("getStatus: 404 failed, >=400 throws, else mapped", async () => {
    expect((await vc(() => ({ status: 404 })).p.getStatus("a.com")).state).toBe("failed");
    await expect(vc(() => ({ status: 500, body: { error: { message: "down" } } })).p.getStatus("a.com")).rejects.toThrow(/down/);
    await expect(vc(() => ({ status: 500, raw: "x" })).p.getStatus("a.com")).rejects.toThrow(/500/);
    expect((await vc((c) => (c.url.includes("/config") ? { body: {} } : { body: { name: "a.com", verified: true } })).p.getStatus("a.com")).state).toBe("active");
  });
  it("delete: 404 ok, 500 throws", async () => {
    await vc(() => ({ status: 404 })).p.delete("a.com");
    await expect(vc(() => ({ status: 500, body: { error: { message: "bad" } } })).p.delete("a.com")).rejects.toThrow(/bad/);
    await expect(vc(() => ({ status: 500, body: {} })).p.delete("a.com")).rejects.toThrow(/500/);
  });
});

