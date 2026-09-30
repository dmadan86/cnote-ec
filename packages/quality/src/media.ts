// Authorised reads of the private photos (never public URLs).
import { getMediaStore } from "@cnote/media";
import { prisma } from "@cnote/db";

const UUID = /^[0-9a-f-]{36}$/i;

/** viewer: the owning seller business, or staff (the caller has already checked quality.review). */
export async function readQualityMedia(mediaId: string, viewer: { sellerBusinessId: string } | { staff: true }): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  if (!UUID.test(mediaId)) return null;
  const m = await prisma.qualityCheckMedia.findUnique({ where: { id: mediaId } });
  if (!m || m.purgedAt) return null;
  if ("sellerBusinessId" in viewer) {
    const c = await prisma.qualityCheck.findUnique({ where: { id: m.checkId }, select: { sellerBusinessId: true } });
    if (!c || c.sellerBusinessId !== viewer.sellerBusinessId) return null;
  }
  const o = await getMediaStore("private").get(m.key);
  return o ? { bytes: o.bytes, contentType: o.contentType } : null;
}
