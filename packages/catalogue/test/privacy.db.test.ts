import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportPersonalData } from "../src";

const personId = randomUUID();
const sellerBusinessId = randomUUID();
afterAll(async () => {
  await prisma.voiceNote.deleteMany({ where: { personId } });
});

describe("exportPersonalData (DPDP access right)", () => {
  it("exports voice-note metadata and transcript, never the storage key", async () => {
    await prisma.voiceNote.create({
      data: { sellerBusinessId, personId, storageKey: `voice/${personId}.webm`, mimeType: "audio/webm", durationMs: 4200, language: "hi", transcript: "mere paas 500 dibbe hain", purgeAfter: new Date(Date.now() + 86_400_000) },
    });
    const out = (await exportPersonalData(personId)) as { voiceNotes: { items: any[] } };
    expect(out.voiceNotes.items).toHaveLength(1);
    expect(out.voiceNotes.items[0]).toMatchObject({ mimeType: "audio/webm", durationMs: 4200, transcript: "mere paas 500 dibbe hain" });
    expect(JSON.stringify(out)).not.toContain("voice/");
  });
  it("is empty for an unknown person", async () => {
    expect(await exportPersonalData(randomUUID())).toEqual({ voiceNotes: { items: [], truncated: false } });
  });
});
