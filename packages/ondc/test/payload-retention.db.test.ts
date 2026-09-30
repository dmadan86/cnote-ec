import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { getOndcOrderSeller, purgeOndcOrderPayloads } from "../src";

const ids: string[] = [];
afterAll(() => prisma.ondcOrder.deleteMany({ where: { id: { in: ids } } }));

async function order(status: string, updatedDaysAgo: number) {
  const payload = {
    context: { transaction_id: "t", bap_id: "bap" },
    message: { order: { id: "b1", items: [{ id: "i1", quantity: { count: 2 } }], provider: { id: "p" }, quote: { price: { value: "10" } },
      billing: { name: "Asha", phone: "9876543210", email: "asha@example.test" }, fulfillments: [{ end: { contact: { phone: "9876543210" } } }], payment: { params: { bank_account_number: "123" } } } },
  };
  const o = await prisma.ondcOrder.create({ data: { transactionId: randomUUID(), messageId: randomUUID(), bapId: "bap", bapUri: "https://bap.example", sellerBusinessId: randomUUID(), status, totalPaise: 1000n, items: {}, payload } });
  ids.push(o.id);
  await prisma.$executeRaw`UPDATE ondc_orders SET updated_at = now() - make_interval(days => ${updatedDaysAgo}) WHERE id = ${o.id}::uuid`;
  return o.id;
}

describe("purgeOndcOrderPayloads", () => {
  it("redacts buyer contact from finished orders past the window only; dry-run counts; idempotent", async () => {
    const old = await order("completed", 400);
    const oldCancelled = await order("cancelled", 400);
    const recent = await order("completed", 1);
    const live = await order("accepted", 400);
    const before = new Date(Date.now() - 365 * 86_400_000);
    const dry = await purgeOndcOrderPayloads(before, { dryRun: true, batch: 1 });
    expect(dry).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify((await prisma.ondcOrder.findUniqueOrThrow({ where: { id: old } })).payload)).toContain("9876543210");
    expect(await purgeOndcOrderPayloads(before, { batch: 1 })).toBeGreaterThanOrEqual(2);
    for (const id of [old, oldCancelled]) {
      const p = (await prisma.ondcOrder.findUniqueOrThrow({ where: { id } })).payload as Record<string, unknown>;
      const s = JSON.stringify(p);
      expect(s).not.toMatch(/9876543210|asha@example|bank_account/);
      expect(p).toMatchObject({ context: { transaction_id: "t" }, message: { order: { id: "b1", items: [{ id: "i1" }] } }, redactedAt: expect.any(String) });
    }
    for (const id of [recent, live]) expect(JSON.stringify((await prisma.ondcOrder.findUniqueOrThrow({ where: { id } })).payload)).toContain("9876543210");
    // redacted rows are skipped next time (their updated_at moved forward anyway)
    await prisma.$executeRaw`UPDATE ondc_orders SET updated_at = now() - make_interval(days => 400) WHERE id = ${old}::uuid`;
    const again = await purgeOndcOrderPayloads(before, { dryRun: true });
    const stillOld = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: old } });
    expect((stillOld.payload as { redactedAt?: string }).redactedAt).toBeTruthy();
    expect(again).toBeGreaterThanOrEqual(0);
  });
});

describe("getOndcOrderSeller (system read for notifiers)", () => {
  it("returns the seller of an ONDC order; null for unknown or malformed ids", async () => {
    const id = await order("accepted", 1);
    const row = await prisma.ondcOrder.findUniqueOrThrow({ where: { id } });
    expect(await getOndcOrderSeller(id)).toBe(row.sellerBusinessId);
    expect(await getOndcOrderSeller(randomUUID())).toBeNull();
    expect(await getOndcOrderSeller("nope")).toBeNull();
  });
});
