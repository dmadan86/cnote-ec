// DPDP access right (ADR-010): voice-note metadata and transcripts the person recorded. The audio itself is purged on its own schedule and
// is not exported; the internal storage key never is. Registered with @cnote/compliance's export registry.
import { EXPORT_TAKE, exportCollection, type PersonalExport } from "@cnote/core";
import { prisma } from "@cnote/db";

export async function exportPersonalData(personId: string): Promise<PersonalExport> {
  const notes = await prisma.voiceNote.findMany({
    where: { personId }, orderBy: { createdAt: "asc" }, take: EXPORT_TAKE,
    select: { id: true, sellerBusinessId: true, mimeType: true, durationMs: true, language: true, transcript: true, listingId: true, retainAudio: true, purgeAfter: true, createdAt: true },
  });
  return { voiceNotes: exportCollection(notes) };
}
