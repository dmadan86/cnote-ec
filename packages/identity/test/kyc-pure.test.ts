import { describe, expect, it } from "vitest";
import {
  HttpKycProvider, MockKycProvider, editingSoftware, evaluateKycDocument, getKycProvider, imageChecks, setKycProvider, signKycWebhook, verifyKycSignature,
  type DocEvaluationInput,
} from "../src";

const clean = { metadataAnomalies: [], lowResolution: false, likelyScreenshot: false, aspectImplausible: false };
const base = (o: Partial<DocEvaluationInput> = {}): DocEvaluationInput => ({
  docType: "gst_certificate", fields: { gstin: "27ABCDE1234F1Z5", name: "Sharma Steel Pvt Ltd", pan: "ABCDE1234F" },
  declared: { gstin: "27ABCDE1234F1Z5", names: ["Sharma Steel Private Limited"], pan: null, udyam: null },
  forgerySignals: [], aiNeedsReview: false, image: clean, duplicateOtherBusiness: false, ...o,
});
const ids = (r: ReturnType<typeof evaluateKycDocument>, res: string) => r.checks.filter((c) => c.result === res).map((c) => c.id);

describe("image forensics", () => {
  it("finds editing software in head and tail metadata, once each", () => {
    const b = Buffer.concat([Buffer.from("xx Adobe Photoshop 25 CreatorTool Canva photoshop:x"), Buffer.alloc(300 * 1024), Buffer.from("tail Midjourney")]);
    expect(editingSoftware(b).sort()).toEqual(["AI image generator", "Adobe Photoshop", "Canva"].sort());
    expect(editingSoftware(Buffer.from("plain camera Canon EOS"))).toEqual([]);
  });
  it("flags resolution, screenshots and proportions", () => {
    expect(imageChecks(Buffer.alloc(10), "image/jpeg", 1600, 1200)).toEqual(clean);
    expect(imageChecks(Buffer.alloc(10), "image/jpeg", 600, 400).lowResolution).toBe(true);
    expect(imageChecks(Buffer.alloc(10), "image/png", 1920, 1080).likelyScreenshot).toBe(true);
    expect(imageChecks(Buffer.alloc(10), "image/jpeg", 1920, 1080).likelyScreenshot).toBe(false);
    expect(imageChecks(Buffer.alloc(10), "image/jpeg", 4000, 800).aspectImplausible).toBe(true);
    expect(imageChecks(Buffer.from("GIMP"), "image/jpeg", 0, 0).aspectImplausible).toBe(true);
    expect(imageChecks(Buffer.from("GIMP"), "image/jpeg", 2000, 2000).metadataAnomalies).toHaveLength(1);
  });
});

describe("evaluateKycDocument", () => {
  it("passes a clean matching GST certificate", () => {
    const r = evaluateKycDocument(base());
    expect(r.verdict).toBe("pass");
    expect(r.reasons).toEqual([]);
  });
  it("fails on a duplicate from another business, GSTIN mismatch, PAN not in GSTIN", () => {
    expect(evaluateKycDocument(base({ duplicateOtherBusiness: true })).verdict).toBe("fail");
    expect(evaluateKycDocument(base({ fields: { gstin: "27ZZZZZ9999Z1Z5", name: "Sharma Steel" } })).verdict).toBe("fail");
    expect(ids(evaluateKycDocument(base({ fields: { gstin: "27ABCDE1234F1Z5", pan: "ZZZZZ9999Z", name: "Sharma Steel" } })), "fail")).toEqual(["pan"]);
  });
  it("warns when the gstin is unreadable or nothing declared", () => {
    expect(ids(evaluateKycDocument(base({ fields: { name: "Sharma Steel" } })), "warn")).toEqual(["gstin"]);
    const r = evaluateKycDocument(base({ declared: { gstin: null, names: [], pan: null, udyam: null }, fields: { gstin: "27ABCDE1234F1Z5" } }));
    expect(r.verdict).toBe("review");
    expect(ids(r, "warn")).toEqual(["gstin", "name"]);
    expect(evaluateKycDocument(base({ declared: { gstin: "27ABCDE1234F1Z5", names: [], pan: null, udyam: null } })).reasons.join()).toMatch(/No declared name/);
  });
  it("name: partial → review; poor on GST certificate → fail; poor on a PAN card → review; unreadable → review", () => {
    expect(evaluateKycDocument(base({ fields: { gstin: "27ABCDE1234F1Z5", name: "Sharma Steel Traders Delhi" } })).verdict).toBe("review");
    expect(evaluateKycDocument(base({ fields: { gstin: "27ABCDE1234F1Z5", name: "Completely Different" } })).verdict).toBe("fail");
    const pan = evaluateKycDocument(base({ docType: "pan_card", fields: { pan: "ABCDE1234F", name: "Ramesh Sharma" } }));
    expect(pan.verdict).toBe("review");
    expect(evaluateKycDocument(base({ fields: { gstin: "27ABCDE1234F1Z5" } })).reasons.join()).toMatch(/name/);
  });
  it("pan card: matches declared or GSTIN-derived PAN; mismatch fails; nothing to compare warns; missing PAN warns", () => {
    const decl = { gstin: "27ABCDE1234F1Z5", names: ["Ramesh Sharma"], pan: null, udyam: null };
    const f = { pan: "ABCDE1234F", name: "Ramesh Sharma" };
    expect(evaluateKycDocument(base({ docType: "pan_card", fields: f, declared: decl })).verdict).toBe("pass");
    expect(evaluateKycDocument(base({ docType: "pan_card", fields: f, declared: { ...decl, gstin: null, pan: "ABCDE1234F" } })).verdict).toBe("pass");
    expect(evaluateKycDocument(base({ docType: "pan_card", fields: { ...f, pan: "QQQQQ0000Q" }, declared: decl })).verdict).toBe("fail");
    expect(evaluateKycDocument(base({ docType: "pan_card", fields: f, declared: { ...decl, gstin: null } })).verdict).toBe("review");
    expect(evaluateKycDocument(base({ docType: "pan_card", fields: { name: "Ramesh Sharma" }, declared: decl })).verdict).toBe("review");
  });
  it("udyam, bank and address documents", () => {
    const decl = { gstin: null, names: ["Sharma Steel"], pan: null, udyam: "UDYAM-MH-01-0000001" };
    expect(evaluateKycDocument(base({ docType: "udyam_certificate", fields: { udyam: "udyam mh 01 0000001", name: "Sharma Steel" }, declared: decl })).verdict).toBe("pass");
    expect(evaluateKycDocument(base({ docType: "udyam_certificate", fields: { udyam: "UDYAM-MH-01-0000009", name: "Sharma Steel" }, declared: decl })).verdict).toBe("fail");
    expect(evaluateKycDocument(base({ docType: "udyam_certificate", fields: { udyam: "UDYAM-MH-01-0000009", name: "Sharma Steel" }, declared: { ...decl, udyam: null } })).verdict).toBe("pass");
    expect(evaluateKycDocument(base({ docType: "udyam_certificate", fields: { name: "Sharma Steel" }, declared: decl })).verdict).toBe("review");
    expect(evaluateKycDocument(base({ docType: "bank_proof", fields: { accountLast4: "1234", name: "Sharma Steel" }, declared: decl })).verdict).toBe("pass");
    expect(evaluateKycDocument(base({ docType: "bank_proof", fields: { name: "Sharma Steel" }, declared: decl })).verdict).toBe("review");
    expect(evaluateKycDocument(base({ docType: "address_proof", fields: { address: "1 MG Road", name: "Sharma Steel" }, declared: decl })).verdict).toBe("pass");
    expect(evaluateKycDocument(base({ docType: "address_proof", fields: { name: "Sharma Steel" }, declared: decl })).verdict).toBe("review");
  });
  it("forgery, metadata, quality and low AI confidence each force review", () => {
    expect(evaluateKycDocument(base({ forgerySignals: ["font mismatch"] })).reasons.join()).toMatch(/tampering/);
    expect(evaluateKycDocument(base({ image: { ...clean, metadataAnomalies: ["Metadata names editing software: GIMP"] } })).verdict).toBe("review");
    const q = evaluateKycDocument(base({ image: { ...clean, lowResolution: true, likelyScreenshot: true, aspectImplausible: true } }));
    expect(q.reasons.join()).toMatch(/low resolution, looks like a screenshot, unusual proportions/);
    expect(evaluateKycDocument(base({ aiNeedsReview: true })).verdict).toBe("review");
  });
});

describe("KYC providers", () => {
  const body = JSON.stringify({ providerRef: "ref-1" });
  it("signs and verifies webhooks", () => {
    const sig = signKycWebhook("s", body);
    expect(() => verifyKycSignature("s", body, sig)).not.toThrow();
    expect(() => verifyKycSignature("s", body, `sha256=${sig}`)).not.toThrow();
    expect(() => verifyKycSignature("s", body, "00")).toThrow(/signature/);
    expect(() => verifyKycSignature("s", body, signKycWebhook("other", body))).toThrow(/signature/);
    expect(() => verifyKycSignature(undefined, body, sig)).toThrow(/signature/);
    expect(() => verifyKycSignature("s", body, undefined)).toThrow(/signature/);
  });
  it("mock provider: link, configurable result, webhook reference parsing", async () => {
    const m = new MockKycProvider();
    expect(await m.createSession({ sessionId: "s1", businessId: "b", personId: "p" })).toEqual({ providerRef: "mock_s1", url: "/verification?mockKyc=s1" });
    expect((await m.createSession({ sessionId: "s1", businessId: "b", personId: "p", returnUrl: "https://x/v" })).url).toBe("https://x/v?mockKyc=s1");
    expect((await m.getResult()).status).toBe("passed");
    const h = (b: string) => ({ "x-kyc-signature": signKycWebhook("mock-secret", b) });
    expect(m.verifyWebhook(body, h(body))).toEqual({ providerRef: "ref-1" });
    expect(m.verifyWebhook(JSON.stringify({ transactionId: "t" }), h(JSON.stringify({ transactionId: "t" })))).toEqual({ providerRef: "t" });
    expect(() => m.verifyWebhook("{}", h("{}"))).toThrow(/reference/);
    expect(() => m.verifyWebhook("nope", h("nope"))).toThrow(/Malformed/);
    expect(() => m.verifyWebhook(body, {})).toThrow(/signature/);
  });
  const fakeFetch = (status: number, json: unknown) => (async () => ({ ok: status < 400, status, json: async () => json })) as unknown as typeof fetch;
  it("hyperverge adapter maps create + result + webhook", async () => {
    const calls: string[] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push(`${init.method ?? "GET"} ${url}`); return { ok: true, status: 200, json: async () => (init.method === "POST" ? { transactionId: "tx1", link: "https://hv/x" } : { applicationStatus: "auto_approved", livenessScore: 97, faceMatchScore: 0.9, reasons: ["ok", 1] }) }; }) as unknown as typeof fetch;
    const p = new HttpKycProvider({ name: "hyperverge", baseUrl: "https://api", apiKey: "k", webhookSecret: "w", fetch: f });
    expect(await p.createSession({ sessionId: "s", businessId: "b", personId: "p" })).toEqual({ providerRef: "tx1", url: "https://hv/x" });
    expect(await p.getResult("tx 1")).toEqual({ status: "passed", livenessScore: 0.97, faceMatchScore: 0.9, reasons: ["ok"] });
    expect(calls).toEqual(["POST https://api/transactions", "GET https://api/transactions/tx%201"]);
    expect(p.verifyWebhook(body, { "x-kyc-signature": signKycWebhook("w", body) })).toEqual({ providerRef: "ref-1" });
  });
  it("signzy adapter maps statuses; provider errors and missing links are surfaced", async () => {
    const mk = (json: unknown, status = 200) => new HttpKycProvider({ name: "signzy", baseUrl: "https://s", apiKey: "k", webhookSecret: "w", fetch: fakeFetch(status, json) });
    expect(await mk({ status: "rejected", reasons: "x" }).getResult("j")).toMatchObject({ status: "failed", reasons: undefined });
    expect((await mk({ status: "failed" }).getResult("j")).status).toBe("failed");
    expect((await mk({ status: "completed" }).getResult("j")).status).toBe("passed");
    expect((await mk({ status: "failed", reasons: ["face_mismatch", 3] }).getResult("j")).reasons).toEqual(["face_mismatch"]);
    expect((await mk({ status: "approved", livenessScore: "n/a" }).getResult("j")).livenessScore).toBeUndefined();
    expect((await mk({ status: "in_progress" }).getResult("j")).status).toBe("pending");
    expect(await mk({ journeyId: "j1", journeyUrl: "https://s/j" }).createSession({ sessionId: "s", businessId: "b", personId: "p", returnUrl: "r" })).toEqual({ providerRef: "j1", url: "https://s/j" });
    await expect(mk({ id: "only-id" }).createSession({ sessionId: "s", businessId: "b", personId: "p" })).rejects.toThrow(/no session link/);
    await expect(mk({}, 500).getResult("j")).rejects.toThrow(/error \(500\)/);
    const hv = new HttpKycProvider({ name: "hyperverge", baseUrl: "https://s", apiKey: "k", webhookSecret: "w", fetch: fakeFetch(200, { applicationStatus: "auto_declined" }) });
    expect((await hv.getResult("x")).status).toBe("failed");
    const hv2 = new HttpKycProvider({ name: "hyperverge", baseUrl: "https://s", apiKey: "k", webhookSecret: "w", fetch: fakeFetch(200, { applicationStatus: "needs_review" }) });
    expect((await hv2.getResult("x")).status).toBe("pending");
  });
  it("default fetch is used when none injected", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = fakeFetch(200, { transactionId: "t", url: "u" });
    try {
      const p = new HttpKycProvider({ name: "hyperverge", baseUrl: "https://s", apiKey: "k", webhookSecret: "w" });
      expect((await p.createSession({ sessionId: "s", businessId: "b", personId: "p" })).providerRef).toBe("t");
    } finally { globalThis.fetch = orig; }
  });
  it("getKycProvider selects by env", () => {
    expect(getKycProvider({}).name).toBe("mock");
    expect(getKycProvider({ KYC_PROVIDER: "mock", KYC_WEBHOOK_SECRET: "x" }).name).toBe("mock");
    expect(() => getKycProvider({ KYC_PROVIDER: "mock", NODE_ENV: "production" })).toThrow(/production/);
    expect(getKycProvider({ KYC_PROVIDER: "signzy", KYC_API_KEY: "a", KYC_BASE_URL: "b", KYC_WEBHOOK_SECRET: "c" }).name).toBe("signzy");
    expect(() => getKycProvider({ KYC_PROVIDER: "hyperverge" })).toThrow(/required/);
    expect(() => getKycProvider({ KYC_PROVIDER: "nope" })).toThrow(/Unknown/);
    const m = new MockKycProvider();
    setKycProvider(m);
    expect(getKycProvider({})).toBe(m);
    setKycProvider(null);
  });
});
