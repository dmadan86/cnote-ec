// IDfy adapter + vendor mapping edge cases for the hosted-link video-KYC port (ADR-003 T2).
import { describe, expect, it } from "vitest";
import { HttpKycProvider, getKycProvider, setKycProvider, signKycWebhook, MockKycProvider } from "../src";

type Call = { url: string; init: RequestInit };
const recorder = (status: number, json: unknown) => {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify(json), { status }); }) as unknown as typeof fetch;
  return { calls, f };
};
const idfy = (f: typeof fetch, accountId?: string) => new HttpKycProvider({ name: "idfy", baseUrl: "https://idfy.test", apiKey: "key", accountId, webhookSecret: "w", fetch: f });

describe("IDfy adapter", () => {
  it("creates a profile with api-key + account-id headers and maps the link", async () => {
    process.env.KYC_IDFY_CONFIG_ID = "cfg-1";
    const { calls, f } = recorder(200, { profile_id: "p-1", profile_url: "https://idfy.test/p-1" });
    const link = await idfy(f, "acct").createSession({ sessionId: "s1", businessId: "b1", personId: "p", returnUrl: "https://app/back" });
    expect(link).toEqual({ providerRef: "p-1", url: "https://idfy.test/p-1" });
    expect(calls[0]!.url).toBe("https://idfy.test/profiles");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ "api-key": "key", "account-id": "acct", "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ reference_id: "s1", redirect_url: "https://app/back", config_id: "cfg-1", metadata: { businessId: "b1" } });
    delete process.env.KYC_IDFY_CONFIG_ID;
  });
  it("falls back to id / url keys and an empty account id", async () => {
    const { calls, f } = recorder(200, { id: "p-2", url: "https://idfy.test/p-2" });
    expect(await idfy(f).createSession({ sessionId: "s", businessId: "b", personId: "p" })).toEqual({ providerRef: "p-2", url: "https://idfy.test/p-2" });
    expect((calls[0]!.init.headers as Record<string, string>)["account-id"]).toBe("");
  });
  it("maps every status to a verdict and normalises scores (percent or fraction, junk dropped)", async () => {
    const verdict = async (json: unknown) => idfy(recorder(200, json).f).getResult("ref/1");
    expect((await verdict({ status: "APPROVED" })).status).toBe("passed");
    expect((await verdict({ status: "completed" })).status).toBe("passed");
    for (const s of ["rejected", "Declined", "failed"]) expect((await verdict({ status: s })).status).toBe("failed");
    expect((await verdict({ status: "in_progress" })).status).toBe("pending");
    expect((await verdict({})).status).toBe("pending");
    const r = await verdict({ status: "approved", liveness_score: 97, face_match_score: 0.5, reasons: ["ok", 3, "also"] });
    expect(r).toMatchObject({ livenessScore: 0.97, faceMatchScore: 0.5, reasons: ["ok", "also"] });
    const camel = await verdict({ status: "approved", livenessScore: 0.8, faceMatchScore: 80 });
    expect(camel).toMatchObject({ livenessScore: 0.8, faceMatchScore: 0.8 });
    const junk = await verdict({ status: "approved", liveness_score: "high", face_match_score: Number.NaN, reasons: "none" });
    expect(junk.livenessScore).toBeUndefined();
    expect(junk.faceMatchScore).toBeUndefined();
    expect(junk.reasons).toBeUndefined();
  });
  it("encodes the reference in the result path", async () => {
    const { calls, f } = recorder(200, { status: "approved" });
    await idfy(f).getResult("a/b c");
    expect(calls[0]!.url).toBe("https://idfy.test/profiles/a%2Fb%20c");
  });
  it("webhooks verify the HMAC and read the reference", () => {
    const p = idfy(recorder(200, {}).f);
    const body = JSON.stringify({ reference: "ref-9" });
    expect(p.verifyWebhook(body, { "x-kyc-signature": `sha256=${signKycWebhook("w", body)}` })).toEqual({ providerRef: "ref-9" });
    expect(() => p.verifyWebhook(body, {})).toThrow(/Invalid webhook signature/);
  });
});

describe("vendor mapping fallbacks", () => {
  it("hyperverge: link/url fallback and missing session link", async () => {
    const hv = (json: unknown) => new HttpKycProvider({ name: "hyperverge", baseUrl: "https://hv", apiKey: "k", webhookSecret: "w", fetch: recorder(200, json).f });
    expect(await hv({ transactionId: "t", url: "https://hv/l" }).createSession({ sessionId: "s", businessId: "b", personId: "p" })).toEqual({ providerRef: "t", url: "https://hv/l" });
    await expect(hv({ transactionId: "t" }).createSession({ sessionId: "s", businessId: "b", personId: "p" })).rejects.toThrow(/no session link/);
    expect(await hv({ applicationStatus: "auto_approved", reasons: ["a", 1] }).getResult("t")).toMatchObject({ status: "passed", reasons: ["a"] });
  });
  it("signzy: id/url fallback, statuses, bad scores", async () => {
    const sz = (json: unknown) => new HttpKycProvider({ name: "signzy", baseUrl: "https://sz", apiKey: "k", webhookSecret: "w", fetch: recorder(200, json).f });
    expect(await sz({ id: "j", url: "https://sz/j" }).createSession({ sessionId: "s", businessId: "b", personId: "p" })).toEqual({ providerRef: "j", url: "https://sz/j" });
    expect((await sz({ status: "completed", reasons: ["x", 2], livenessScore: 91 }).getResult("j"))).toMatchObject({ status: "passed", livenessScore: 0.91, reasons: ["x"] });
    expect((await sz({ status: "rejected" }).getResult("j")).status).toBe("failed");
    expect((await sz({}).getResult("j")).status).toBe("pending");
  });
});

describe("getKycProvider", () => {
  it("idfy needs an account id; the override wins over env", () => {
    expect(() => getKycProvider({ KYC_PROVIDER: "idfy", KYC_API_KEY: "a", KYC_BASE_URL: "b", KYC_WEBHOOK_SECRET: "c" })).toThrow(/KYC_ACCOUNT_ID/);
    expect(getKycProvider({ KYC_PROVIDER: "IDFY", KYC_API_KEY: "a", KYC_BASE_URL: "b", KYC_WEBHOOK_SECRET: "c", KYC_ACCOUNT_ID: "x" }).name).toBe("idfy");
    expect(() => getKycProvider({ KYC_PROVIDER: "nope" })).toThrow(/Unknown KYC_PROVIDER/);
    expect(() => getKycProvider({ KYC_PROVIDER: "mock", NODE_ENV: "production" })).toThrow(/not allowed in production/);
    const mock = new MockKycProvider();
    setKycProvider(mock);
    try { expect(getKycProvider({ KYC_PROVIDER: "nope" })).toBe(mock); } finally { setKycProvider(null); }
  });
});
