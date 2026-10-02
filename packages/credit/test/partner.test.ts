import { afterEach, describe, expect, it, vi } from "vitest";
import { MockPartner, NbfcPartnerStub, SIGNATURE_HEADER, assertMockAllowed, configuredPartnerName, getCreditPartner, isPartnerName, mockPricing, parsePartnerEvent, setCreditPartner, verifySigned, hmacHex } from "../src/partner";
import { uid } from "./helpers";

const req = (score: number, amount = 1_000_000, tenor = 30) => ({
  applicationRef: uid(), product: "invoice_financing" as const, amountPaise: amount, tenorDays: tenor, borrowerRef: uid(),
  score: { value: score, band: "good", modelVersion: "credit-v1", reasonCodes: [] }, features: {}, collateral: { kind: "escrow" as const, escrowRef: uid(), orderRef: uid(), orderAmountPaise: amount },
});

afterEach(() => { vi.unstubAllEnvs(); setCreditPartner(null); });

describe("mock partner", () => {
  const p = new MockPartner();
  it("prices deterministically: better score, lower APR, floors and ceilings", () => {
    expect(mockPricing(499, 100, 30).approve).toBe(false);
    expect(mockPricing(520, 1000, 30).offer).toMatchObject({ amountPaise: 600 });
    expect(mockPricing(550, 1000, 30).offer!.amountPaise).toBe(1000);
    expect(mockPricing(700, 1000, 30).offer!.aprBps).toBeLessThan(mockPricing(600, 1000, 30).offer!.aprBps);
    expect(mockPricing(900, 1000, 30).offer!.aprBps).toBe(1200);
    expect(mockPricing(500, 1000, 30).offer!.aprBps).toBe(3600);
  });
  it("submit -> offers; getOffers recomputes from the ref (stateless); accept checks the offer belongs", async () => {
    const r = await p.submitApplication(req(700));
    expect(r.status).toBe("offered");
    expect(await p.getOffers(r.partnerRef)).toEqual(r.offers);
    expect(await p.getOffers("garbage")).toEqual([]);
    expect(await p.getOffers("mock:a:100:30:400")).toEqual([]);
    expect((await p.acceptOffer(r.partnerRef, r.offers[0]!.offerRef, { acceptedAt: new Date(), personRef: "x" })).status).toBe("accepted");
    expect((await p.acceptOffer(r.partnerRef, "other", { acceptedAt: new Date(), personRef: "x" })).status).toBe("failed");
    expect((await p.submitApplication(req(450))).status).toBe("rejected");
    expect(await p.getDisbursementStatus()).toEqual({ status: "pending" });
    expect(await p.listRepayments()).toEqual([]);
  });
  it("signs webhooks and verifies them (bad signature, tamper, missing header, malformed)", () => {
    const { raw, headers } = p.signedEvent({ eventId: "e1", type: "loan.repayment", partnerRef: "r", loanRef: "l", amountPaise: 5, source: "borrower" });
    expect(p.verifyWebhook(raw, headers)).toMatchObject({ eventId: "e1", type: "loan.repayment", amountPaise: 5 });
    expect(p.verifyWebhook(raw, new Headers())).toBeNull();
    expect(p.verifyWebhook(raw, new Headers({ [SIGNATURE_HEADER]: "00" }))).toBeNull();
    expect(p.verifyWebhook(new TextEncoder().encode(Buffer.from(raw).toString().replace("5", "9")), headers)).toBeNull();
    const bad = new TextEncoder().encode("not json");
    expect(p.verifyWebhook(bad, new Headers({ [SIGNATURE_HEADER]: hmacHex("test-credit-webhook-secret", bad) }))).toBeNull();
  });
  it("uses CREDIT_WEBHOOK_SECRET when set", () => {
    vi.stubEnv("CREDIT_WEBHOOK_SECRET", "s3cret");
    const { raw, headers } = p.signedEvent({ eventId: "e", type: "loan.overdue", partnerRef: "r", dpd: 3 });
    expect(p.verifyWebhook(raw, headers)?.dpd).toBe(3);
    expect(verifySigned("other", raw, headers)).toBeNull();
  });
  it("mock is refused in production unless explicitly allowed", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertMockAllowed()).toThrow(/disabled in production/);
    vi.stubEnv("CREDIT_MOCK_CHECKOUT", "1");
    expect(() => assertMockAllowed()).not.toThrow();
  });
});

describe("event parsing", () => {
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const ok = { eventId: "e", type: "application.offered", partnerRef: "r", at: "2026-01-01T00:00:00Z", offers: [{ offerRef: "o", amountPaise: 100, aprBps: 1000, tenorDays: 30, processingFeePaise: 1, otherFeesPaise: 0, expiresAt: "2026-01-02T00:00:00Z" }] };
  it("accepts a valid body and rejects invalid ones", () => {
    expect(parsePartnerEvent(enc(ok))?.offers?.[0]?.expiresAt).toEqual(new Date("2026-01-02T00:00:00Z"));
    expect(parsePartnerEvent(enc({ ...ok, at: "nope" }))).toBeNull();
    expect(parsePartnerEvent(enc({ ...ok, type: "loan.mystery" }))).toBeNull();
    expect(parsePartnerEvent(enc({ ...ok, offers: [{ offerRef: "o", amountPaise: -1 }] }))).toBeNull();
    expect(parsePartnerEvent(new TextEncoder().encode("{"))).toBeNull();
  });
});

describe("real adapter stub + factory", () => {
  it("throws 'not configured' for underwriting and money calls; webhook verification needs a secret", () => {
    vi.stubEnv("CREDIT_LENDER_NAME", "Acme NBFC");
    const s = new NbfcPartnerStub();
    expect(s.lender.name).toBe("Acme NBFC");
    for (const call of [() => s.submitApplication(), () => s.getOffers(), () => s.acceptOffer(), () => s.getDisbursementStatus(), () => s.listRepayments()]) expect(call).toThrow(/not configured/);
    const { raw, headers } = new MockPartner().signedEvent({ eventId: "e", type: "loan.closed", partnerRef: "r" });
    vi.stubEnv("CREDIT_WEBHOOK_SECRET", "");
    expect(s.verifyWebhook(raw, headers)).toBeNull();
    vi.stubEnv("CREDIT_WEBHOOK_SECRET", "test-credit-webhook-secret");
    expect(s.verifyWebhook(raw, headers)?.type).toBe("loan.closed");
  });
  it("factory: default mock, env selection, unknown names, override", () => {
    expect(configuredPartnerName({})).toBe("mock");
    expect(configuredPartnerName({ CREDIT_PARTNER: "nbfc_partner" })).toBe("nbfc_partner");
    expect(() => configuredPartnerName({ CREDIT_PARTNER: "bogus" })).toThrow(/Unknown CREDIT_PARTNER/);
    expect(isPartnerName("mock")).toBe(true);
    expect(isPartnerName("x")).toBe(false);
    expect(getCreditPartner("mock")).toBe(getCreditPartner("mock"));
    expect(getCreditPartner("nbfc_partner").name).toBe("nbfc_partner");
    expect(() => getCreditPartner("paypal")).toThrow(/Unknown credit partner/);
    const fake = new MockPartner();
    setCreditPartner(fake);
    expect(getCreditPartner("mock")).toBe(fake);
    expect(getCreditPartner()).toBe(fake);
  });
});
