import { prisma } from "@cnote/db";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RATE_CARD, activateRateCard, estimateFreight, getActiveRateCard, listRateCards, parseRateCardJson, resetRateCardToDefault, saveRateCard } from "../src";

beforeEach(async () => {
  await prisma.freightRateCard.deleteMany({});
  await resetRateCardToDefault();
});

describe("rate card store", () => {
  it("falls back to the default, versions edits, rolls back", async () => {
    expect(await getActiveRateCard()).toEqual(DEFAULT_RATE_CARD);
    const v1 = await saveRateCard({ ...DEFAULT_RATE_CARD, fuelSurchargeBps: 2000 }, null, "fuel up");
    const v2 = await saveRateCard({ ...DEFAULT_RATE_CARD, fuelSurchargeBps: 3000 }, null, null);
    expect(v2.version).toBe(v1.version + 1);
    expect((await getActiveRateCard()).fuelSurchargeBps).toBe(3000);
    await activateRateCard(v1.version);
    expect((await getActiveRateCard()).fuelSurchargeBps).toBe(2000);
    expect((await listRateCards()).filter((r) => r.isActive)).toHaveLength(1);
    await resetRateCardToDefault();
    expect(await getActiveRateCard()).toEqual(DEFAULT_RATE_CARD);
  });

  it("the estimator uses the active card", async () => {
    const req = { originPincode: "110001", destinationPincode: "400001", quantity: 2, unitWeightGrams: 1000 };
    const before = await estimateFreight(req);
    await saveRateCard({ ...DEFAULT_RATE_CARD, fuelSurchargeBps: 0 }, null, null);
    const after = await estimateFreight(req);
    expect(after.fuelSurchargeBps).toBe(0);
    expect(after.midPaise).toBeLessThan(before.midPaise);
  });

  it("rejects bad JSON and invalid cards", () => {
    expect(() => parseRateCardJson("{nope")).toThrow(/JSON/);
    expect(() => parseRateCardJson("{}")).toThrow(/Invalid rate card/);
    expect(parseRateCardJson(JSON.stringify(DEFAULT_RATE_CARD)).gstBps).toBe(1800);
  });
});
