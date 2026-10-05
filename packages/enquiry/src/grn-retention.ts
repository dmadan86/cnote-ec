// Retention (ADR-010, DPDP s.8(7) storage limitation) for goods receipt notes. The quantities, numbers and dates of a receipt are commercial / tax
// evidence (GST record keeping, Income Tax Act, limitation periods) and stay; what goes after the window is the personal data inside them: the
// receiver's name and the delivery / damage photos (which can show people and premises). Called by @cnote/compliance's RetentionPolicy registry.
import { prisma } from "@cnote/db";
import { getMediaStore } from "@cnote/media";

const BATCH = 200;
export const ERASED_RECEIVER = "(erased)";

/**
 * Purges photos and receiver names of goods receipts created before `before` whose order is closed (completed or cancelled). Idempotent.
 * `dryRun` only counts. Returns receipts affected.
 */
export async function purgeGoodsReceiptPhotos(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const store = getMediaStore("private");
  let affected = 0;
  let after: string | undefined;
  for (;;) {
    const receipts = await prisma.goodsReceipt.findMany({
      where: {
        createdAt: { lt: before },
        OR: [{ receiverName: { not: ERASED_RECEIVER } }, { photos: { some: {} } }],
      },
      select: { id: true, photos: { select: { id: true, key: true } }, orderId: true },
      orderBy: { id: "asc" },
      take: BATCH,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    });
    if (receipts.length === 0) break;
    after = receipts[receipts.length - 1]!.id;
    const closed = new Set((await prisma.order.findMany({ where: { id: { in: receipts.map((r) => r.orderId) }, status: { in: ["completed", "cancelled"] } }, select: { id: true } })).map((o) => o.id));
    for (const r of receipts) {
      if (!closed.has(r.orderId)) continue;
      affected++;
      if (opts.dryRun) continue;
      for (const p of r.photos) await store.delete(p.key).catch(() => undefined);
      await prisma.$transaction([
        prisma.goodsReceiptPhoto.deleteMany({ where: { receiptId: r.id } }),
        prisma.goodsReceipt.update({ where: { id: r.id }, data: { receiverName: ERASED_RECEIVER } }),
      ]);
    }
    if (receipts.length < BATCH) break;
  }
  return affected;
}
