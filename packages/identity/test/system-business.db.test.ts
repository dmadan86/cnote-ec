import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import { ensureSystemBuyerBusiness } from "../src";

describe("ensureSystemBuyerBusiness", () => {
  it("is deterministic and idempotent, creates a buyer-only business with no members", async () => {
    const a = await ensureSystemBuyerBusiness("test-net", "Test network buyer");
    const b = await ensureSystemBuyerBusiness("test-net", "Renamed");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const row = await prisma.business.findUniqueOrThrow({ where: { id: a }, include: { members: true } });
    expect(row).toMatchObject({ name: "Test network buyer", isSeller: false, isBuyer: true });
    expect(row.members).toHaveLength(0);
    expect(await ensureSystemBuyerBusiness("other-net", "x")).not.toBe(a);
  });
  it("rejects malformed keys", async () => {
    await expect(ensureSystemBuyerBusiness("Bad Key!", "x")).rejects.toThrow(/Invalid system business key/);
  });
});
