import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDecisionMeta, scoreIntent } from "../src";

describe("getDecisionMeta", () => {
  it("returns provider/model/prompt version of a logged decision, null for unknown ids", async () => {
    const r = await scoreIntent({ title: "Cotton yarn 30s", requirement: "Need 500 kg cotton yarn 30s count delivered to Tiruppur", buyerVerificationTier: 0, buyerPhoneVerified: true, buyerPriorEnquiries: 0, buyerPriorResponded: 0 }, { type: "enquiry", id: randomUUID() });
    const meta = await getDecisionMeta(r.decisionId);
    expect(meta).toMatchObject({ provider: expect.any(String), modelId: expect.any(String), promptVersion: expect.any(String) });
    expect(await getDecisionMeta(randomUUID())).toBeNull();
  });
});
