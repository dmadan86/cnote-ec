// DPDP access right (ADR-010): the person's saved-product lists. Registered with @cnote/compliance's export registry.
import { EXPORT_TAKE, exportCollection, type PersonalExport } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string): Promise<PersonalExport> {
  const lists = await prisma.wishlist.findMany({
    where: { personId },
    orderBy: { createdAt: "asc" },
    take: EXPORT_TAKE,
    include: { items: { orderBy: { createdAt: "asc" }, take: EXPORT_TAKE, select: { listingId: true, note: true, savedPricePaise: true, createdAt: true } }, share: { select: { createdAt: true } } },
  });
  return {
    wishlists: exportCollection(
      lists.map((l) => ({ id: l.id, name: l.name, isDefault: l.isDefault, createdAt: l.createdAt, publicShareLinkActive: !!l.share, items: l.items })),
    ),
  };
}
