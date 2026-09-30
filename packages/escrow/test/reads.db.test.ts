import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { escrowHistoryForBusiness, listEscrowsForBusiness } from "../src";
import { cleanup, mkBusiness } from "./helpers";

afterAll(cleanup);

let seq = 0;
async function mkEscrow(buyer: string, seller: string, status: string, amount: number, opts: { frozen?: boolean; at?: Date } = {}) {
  const e = await prisma.escrowAgreement.create({
    data: { orderId: randomUUID(), buyerBusinessId: buyer, sellerBusinessId: seller, status, amountPaise: BigInt(amount), feePaise: 0n, partner: "mock", createdAt: opts.at ?? new Date(Date.now() - (seq += 1) * 1000) },
  });
  if (opts.frozen) await prisma.escrowFreeze.create({ data: { escrowId: e.id, disputeId: randomUUID(), resolvedAt: new Date() } });
  return e;
}
const cleanEscrows = async (ids: string[]) => {
  await prisma.escrowFreeze.deleteMany({ where: { escrowId: { in: ids } } });
  await prisma.escrowAgreement.deleteMany({ where: { id: { in: ids } } });
};

describe("escrowHistoryForBusiness", () => {
  it("counts completed, value, clean (never frozen) and refunds across every escrow, beyond any page size", async () => {
    const seller = await mkBusiness(true), buyer = await mkBusiness(), other = await mkBusiness();
    const ids: string[] = [];
    for (let i = 0; i < 230; i++) ids.push((await mkEscrow(buyer, seller, "released", 1_000)).id); // more than the old 200-row page
    ids.push((await mkEscrow(buyer, seller, "released", 5_000, { frozen: true })).id); // frozen once (resolved): not clean
    ids.push((await mkEscrow(buyer, seller, "refunded", 700)).id);
    ids.push((await mkEscrow(buyer, seller, "funded", 900)).id); // not counted
    ids.push((await mkEscrow(other, seller, "released", 100)).id);
    const h = await escrowHistoryForBusiness(seller);
    expect(h).toEqual({ completed: 232, completedPaise: 230_000 + 5_000 + 100, clean: 231, refunded: 1 });
    expect(await escrowHistoryForBusiness(seller, { role: "buyer" })).toEqual({ completed: 0, completedPaise: 0, clean: 0, refunded: 0 });
    expect(await escrowHistoryForBusiness(buyer, { role: "buyer" })).toMatchObject({ completed: 231, refunded: 1 });
    expect(await escrowHistoryForBusiness(buyer)).toMatchObject({ completed: 231 });
    expect(await escrowHistoryForBusiness("not-a-uuid")).toEqual({ completed: 0, completedPaise: 0, clean: 0, refunded: 0 });
    await cleanEscrows(ids);
  });
});

describe("listEscrowsForBusiness", () => {
  it("filters by role and status and pages by keyset without gaps or repeats", async () => {
    const seller = await mkBusiness(true), buyer = await mkBusiness();
    const ids: string[] = [];
    const same = new Date(Date.now() - 60_000); // identical timestamps exercise the id tiebreak
    for (let i = 0; i < 7; i++) ids.push((await mkEscrow(buyer, seller, i % 2 ? "funded" : "released", 100 + i, { at: same })).id);
    ids.push((await mkEscrow(seller, buyer, "funded", 999)).id); // seller is the buyer here
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listEscrowsForBusiness(seller, { role: "seller", cursor, limit: 3 });
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const funded = await listEscrowsForBusiness(seller, { role: "seller", status: "funded" });
    expect(funded.items).toHaveLength(3);
    expect(funded.items.every((r) => r.status === "funded" && r.sellerBusinessId === seller)).toBe(true);
    expect((await listEscrowsForBusiness(seller)).items).toHaveLength(8);
    expect((await listEscrowsForBusiness(seller, { role: "buyer" })).items).toHaveLength(1);
    expect(funded.items[0]).toMatchObject({ heldPaise: expect.any(Number) });
    await expect(listEscrowsForBusiness(seller, { cursor: "garbage" })).rejects.toMatchObject({ code: "validation" });
    expect(await listEscrowsForBusiness("nope")).toEqual({ items: [], nextCursor: null });
    await cleanEscrows(ids);
  });
});
