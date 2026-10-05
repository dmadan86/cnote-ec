// ADR-002: the fake-lead risk computed at enquiry creation lowers the intent score for every provider, explains itself, and is logged in the decision input.
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import { FAKE_LEAD_RISK_MAX_PENALTY, scoreIntent, type IntentInput } from "../src";

const base: IntentInput = { title: "TMT steel rods 10mm", requirement: "Need 500 kg of 10mm Fe500 TMT rods delivered to Pune 411019 within 2 weeks", quantity: 500, quantityUnit: "kg", deliveryPincode: "411019", buyerVerificationTier: 1, buyerPhoneVerified: true, buyerPriorEnquiries: 0, buyerPriorResponded: 0 };

describe("fakeLeadRisk feature", () => {
  it("subtracts proportionally (max 40), adds the first reason, and is logged with the decision", async () => {
    const id = randomUUID();
    const clean = await scoreIntent(base, { type: "enquiry", id: randomUUID() });
    const none = await scoreIntent({ ...base, fakeLeadRisk: { score: 0, reasons: [] } }, { type: "enquiry", id: randomUUID() });
    expect(none.score).toBe(clean.score);
    const half = await scoreIntent({ ...base, fakeLeadRisk: { score: 50, reasons: ["Automated browser signature"] } }, { type: "enquiry", id });
    expect(half.score).toBe(Math.max(0, clean.score - 20));
    expect(half.reasons[0]).toMatch(/Fake-lead risk signals \(-20\).*Automated browser/);
    const max = await scoreIntent({ ...base, fakeLeadRisk: { score: 100, reasons: [] } }, { type: "enquiry", id: randomUUID() });
    expect(max.score).toBe(Math.max(0, clean.score - FAKE_LEAD_RISK_MAX_PENALTY));
    const row = await prisma.aiDecision.findUnique({ where: { id: half.decisionId } });
    expect(JSON.stringify(row?.inputRedacted)).toContain("Automated browser signature");
  });
});
