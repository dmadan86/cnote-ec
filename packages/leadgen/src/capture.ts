import { getPublicListing } from "@cnote/catalogue";
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { hashPhone } from "@cnote/identity";
import { startCaptureSchema, type StartCaptureInput } from "./types";

/** Step 1: unlock prompt opened. Stores no phone. */
export async function startCapture(input: StartCaptureInput, personId?: string | null): Promise<{ captureId: string }> {
  const d = startCaptureSchema.parse(input);
  // Captures start from public pages, so only a LIVE listing counts (catalogue's public read model).
  const live = d.listingId ? await getPublicListing(d.listingId) : null;
  const listing = live ? { sellerBusinessId: live.sellerBusinessId, categoryId: live.category.id } : null;
  const row = await prisma.leadCapture.create({
    data: {
      visitorId: d.visitorId, trigger: d.trigger, unlock: d.unlock, listingId: listing ? d.listingId : null,
      sellerBusinessId: listing?.sellerBusinessId ?? null, categoryId: listing?.categoryId ?? null,
      attribution: d.attribution, followUpConsent: d.followUpConsent, personId: personId ?? null,
    },
    select: { id: true },
  });
  return { captureId: row.id };
}

/** Step 2: code sent. Only sha256(phone) is stored. Moves started -> otp_sent (never backwards). */
export async function markOtpSent(captureId: string, phone: string, followUpConsent?: boolean): Promise<void> {
  const r = await prisma.leadCapture.updateMany({
    where: { id: captureId, status: { in: ["started", "otp_sent", "abandoned"] } },
    data: { status: "otp_sent", phoneHash: hashPhone(phone), ...(followUpConsent === undefined ? {} : { followUpConsent }) },
  });
  if (r.count === 0) throw new DomainError("not_found", "This request has expired. Please start again.");
}

/** Step 3: phone verified and a session issued. Checks the capture was for this phone. Idempotent. */
export async function markVerified(captureId: string, personId: string, isNewPerson: boolean, phone?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const c = await tx.leadCapture.findUnique({ where: { id: captureId } });
    if (!c) throw new DomainError("not_found", "This request has expired. Please start again.");
    if (phone && c.phoneHash && c.phoneHash !== hashPhone(phone)) throw new DomainError("validation", "Phone number does not match this request.");
    if (c.personId && c.personId !== personId) throw new DomainError("forbidden", "This request belongs to another account.");
    if (c.status === "verified" || c.status === "converted") return;
    await tx.leadCapture.update({ where: { id: captureId }, data: { status: "verified", personId } });
    await emit(tx, "LeadCaptureVerified", { type: "LeadCapture", id: captureId }, {
      captureId, personId, trigger: c.trigger, unlock: c.unlock, listingId: c.listingId, isNewPerson,
    });
  });
}

export async function markConverted(captureId: string, personId: string, enquiryId: string | null): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const r = await tx.leadCapture.updateMany({
      where: { id: captureId, personId, status: { in: ["verified"] } },
      data: { status: "converted", enquiryId },
    });
    if (r.count === 0) return;
    const c = await tx.leadCapture.findUniqueOrThrow({ where: { id: captureId }, select: { trigger: true } });
    await emit(tx, "LeadCaptureConverted", { type: "LeadCapture", id: captureId }, { captureId, personId, trigger: c.trigger, enquiryId });
  });
}

export async function getCapture(captureId: string) {
  return prisma.leadCapture.findUnique({ where: { id: captureId } });
}
