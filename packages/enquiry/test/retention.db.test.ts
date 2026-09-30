import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { RETENTION_TOMBSTONE, purgeInactiveConversationMessages } from "../src";

const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day);
const tag = randomUUID().slice(0, 8);
const ids = { person: "", biz: "", enquiry: "", match: [] as string[], conv: [] as string[] };

async function conversation(sellerSuffix: string, msgAges: number[]) {
  const seller = await prisma.business.create({ data: { name: `ret-seller-${tag}-${sellerSuffix}`, isSeller: true } });
  const m = await prisma.match.create({ data: { enquiryId: ids.enquiry, sellerBusinessId: seller.id, rank: 1, matchScore: 1, status: "accepted", respondBy: new Date() } });
  const c = await prisma.conversation.create({ data: { matchId: m.id } });
  ids.match.push(m.id);
  ids.conv.push(c.id);
  const rows = [];
  for (const a of msgAges) rows.push(await prisma.message.create({ data: { conversationId: c.id, senderPersonId: ids.person, body: `hello ${a}`, createdAt: ago(a) } }));
  return { conv: c, rows, sellerId: seller.id };
}

const sellers: string[] = [];
afterAll(async () => {
  await prisma.message.deleteMany({ where: { conversationId: { in: ids.conv } } });
  await prisma.conversation.deleteMany({ where: { id: { in: ids.conv } } });
  await prisma.match.deleteMany({ where: { id: { in: ids.match } } });
  await prisma.enquiry.deleteMany({ where: { id: ids.enquiry } });
  await prisma.business.deleteMany({ where: { id: { in: [...sellers, ids.biz] } } });
  await prisma.person.deleteMany({ where: { id: ids.person } });
});

describe("purgeInactiveConversationMessages", () => {
  it("tombstones only bodies in conversations inactive since the cutoff; idempotent; dry-run counts", async () => {
    const p = await prisma.person.create({ data: { email: `ret-${tag}@example.test` } });
    const b = await prisma.business.create({ data: { name: `ret-buyer-${tag}` } });
    ids.person = p.id;
    ids.biz = b.id;
    ids.enquiry = (await prisma.enquiry.create({ data: { buyerBusinessId: b.id, buyerPersonId: p.id, title: "t", requirement: "r" } })).id;
    const old = await conversation("old", [900, 800]);
    const active = await conversation("active", [900, 1]);
    sellers.push(old.sellerId, active.sellerId);
    const cutoff = ago(730);

    expect(await purgeInactiveConversationMessages(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: old.rows[0]!.id } })).body).toBe("hello 900");

    expect(await purgeInactiveConversationMessages(cutoff)).toBeGreaterThanOrEqual(2);
    const after = await prisma.message.findMany({ where: { conversationId: { in: [old.conv.id, active.conv.id] } } });
    for (const m of after) {
      if (m.conversationId === old.conv.id) expect(m.body).toBe(RETENTION_TOMBSTONE);
      else expect(m.body).not.toBe(RETENTION_TOMBSTONE);
    }
    const again = await purgeInactiveConversationMessages(cutoff);
    const stillOurs = await prisma.message.count({ where: { conversationId: old.conv.id, body: { not: RETENTION_TOMBSTONE } } });
    expect(stillOurs).toBe(0);
    expect(again).toBeGreaterThanOrEqual(0);
  });
});
