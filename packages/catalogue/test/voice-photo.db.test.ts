import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { setConsent } from "@cnote/identity";
import { LocalMediaStore, setMediaStore, solidJpeg } from "@cnote/media";
import { MOCK_TRANSCRIPT_PREFIX } from "@cnote/ai";

const cat = await import("../src/index");
const { voiceStorage } = await import("../src/voice");
const tag = randomUUID().slice(0, 8);
let dir = "";
let store: LocalMediaStore;
let biz: string[] = [];
const people: string[] = [];
const audio = (text: string) => new TextEncoder().encode(MOCK_TRANSCRIPT_PREFIX + text);
const SAY = "3 ply corrugated boxes, 180 gsm, Rs 5.20 per piece, MOQ 500 pcs";

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "voice-test-"));
  store = new LocalMediaStore(dir);
  setMediaStore(store);
  setJobQueue(new MemoryJobQueue());
  await cat.upsertCategories([{ slug: `t-voice-${tag}`, name: `Test Voice ${tag}` }]);
  for (const n of ["A", "B"]) biz.push((await prisma.business.create({ data: { name: `Voice ${n} ${tag}`, isSeller: true } })).id);
  for (let i = 0; i < 3; i++) people.push((await prisma.person.create({ data: { email: `voice-${i}-${tag}@example.test` } })).id);
});

afterAll(async () => {
  const notes = await prisma.voiceNote.findMany({ where: { sellerBusinessId: { in: biz } }, select: { id: true } });
  const images = await prisma.listingImage.findMany({ where: { sellerBusinessId: { in: biz } }, select: { id: true } });
  const ids = [...notes, ...images].map((x) => x.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.aiDecision.deleteMany({ where: { OR: [{ subjectId: { in: ids } }, { subjectType: "listing", subjectId: { in: (await prisma.listing.findMany({ where: { sellerBusinessId: { in: biz } }, select: { id: true } })).map((l) => l.id) } }] } }).catch(() => {});
  await prisma.voiceNote.deleteMany({ where: { sellerBusinessId: { in: biz } } });
  await prisma.listingImage.deleteMany({ where: { sellerBusinessId: { in: biz } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { sellerBusinessId: { in: biz } } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { sellerBusinessId: { in: biz } } });
  await prisma.business.deleteMany({ where: { id: { in: biz } } });
  await prisma.consent.deleteMany({ where: { personId: { in: people } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } });
  setMediaStore(undefined);
  setJobQueue(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe("voice notes", () => {
  it("stores audio privately, snapshots no-consent retention (24h) and rejects bad input", async () => {
    const v = await cat.createVoiceNote(biz[0]!, people[0]!, { bytes: audio(SAY), mimeType: "audio/ogg; codecs=opus" });
    expect(v).toMatchObject({ retainAudio: false, hasAudio: true, transcript: null });
    const row = await prisma.voiceNote.findUniqueOrThrow({ where: { id: v.id } });
    expect(row.mimeType).toBe("audio/ogg");
    expect(await store.exists(row.storageKey!)).toBe(true);
    expect(row.storageKey).toMatch(/^(listings\/_voice\/[0-9a-f-]{36}\.ogg|bulk\/_voice\/[0-9a-f-]{36}\.zip)$/);
    expect(row.purgeAfter.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(row.purgeAfter.getTime() - Date.now()).toBeLessThan(24.1 * 3600_000);
    for (const bad of [{ bytes: audio(SAY), mimeType: "video/mp4" }, { bytes: new Uint8Array(0), mimeType: "audio/ogg" }, { bytes: new Uint8Array(10 * 1024 * 1024 + 1), mimeType: "audio/wav" }]) {
      await expect(cat.createVoiceNote(biz[0]!, people[0]!, bad)).rejects.toMatchObject({ code: "validation" });
    }
    expect((await cat.getVoiceNote(biz[0]!, v.id)).id).toBe(v.id);
    await expect(cat.getVoiceNote(biz[1]!, v.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(cat.getVoiceNote(biz[0]!, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("removes the store object if the row insert fails", async () => {
    const spy = vi.spyOn(prisma.voiceNote, "create").mockRejectedValueOnce(new Error("db down"));
    const before = await prisma.voiceNote.count({ where: { sellerBusinessId: biz[0]! } });
    await expect(cat.createVoiceNote(biz[0]!, people[0]!, { bytes: audio(SAY), mimeType: "audio/mpeg" })).rejects.toThrow("db down");
    spy.mockRestore();
    expect(await prisma.voiceNote.count({ where: { sellerBusinessId: biz[0]! } })).toBe(before);
  });

  it("transcribes once, emits VoiceNoteTranscribed and deletes audio without consent", async () => {
    const v = await cat.createVoiceNote(biz[0]!, people[0]!, { bytes: audio(SAY), mimeType: "audio/webm" });
    const key = (await prisma.voiceNote.findUniqueOrThrow({ where: { id: v.id } })).storageKey!;
    const t = await cat.transcribeVoiceNote(v.id, { language: "en" });
    expect(t).toMatchObject({ transcript: SAY, confidence: 0.9, hasAudio: false });
    expect(await store.exists(key)).toBe(false);
    expect(await prisma.domainEvent.count({ where: { type: "VoiceNoteTranscribed", aggregateId: v.id } })).toBe(1);
    expect((await cat.transcribeVoiceNote(v.id)).transcript).toBe(SAY); // idempotent: no second event
    expect(await prisma.domainEvent.count({ where: { type: "VoiceNoteTranscribed", aggregateId: v.id } })).toBe(1);
  });

  it("keeps audio 180 days with the voice_retention consent", async () => {
    await setConsent(people[1]!, "voice_retention", true, "test");
    const v = await cat.createVoiceNote(biz[0]!, people[1]!, { bytes: audio(SAY), mimeType: "audio/mp4" });
    expect(v.retainAudio).toBe(true);
    expect(new Date(v.purgeAfter).getTime() - Date.now()).toBeGreaterThan(179 * 86_400_000);
    const t = await cat.transcribeVoiceNote(v.id, { language: "xx" }); // unknown hint tolerated
    expect(t.hasAudio).toBe(true);
  });

  it("fails clearly when the audio is gone or missing", async () => {
    const gone = await prisma.voiceNote.create({ data: { sellerBusinessId: biz[0]!, personId: people[0]!, storageKey: null, mimeType: "audio/ogg", purgeAfter: new Date() } });
    await expect(cat.transcribeVoiceNote(gone.id)).rejects.toMatchObject({ code: "conflict" });
    const lost = await prisma.voiceNote.create({ data: { sellerBusinessId: biz[0]!, personId: people[0]!, storageKey: `bulk/_voice/${randomUUID()}.zip`, mimeType: "audio/ogg", purgeAfter: new Date() } });
    await expect(cat.transcribeVoiceNote(lost.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("drafts a listing from the transcript, links it, and is idempotent", async () => {
    const v = await cat.createVoiceNote(biz[0]!, people[0]!, { bytes: audio(SAY), mimeType: "audio/ogg" });
    await expect(cat.draftListingFromVoice(biz[1]!, people[0]!, v.id, "en")).rejects.toMatchObject({ code: "forbidden" });
    const d = await cat.draftListingFromVoice(biz[0]!, people[0]!, v.id, "en");
    expect(d.transcript).toBe(SAY);
    expect(d.listing).toMatchObject({ aiGenerated: true, status: "draft", sellerBusinessId: biz[0] });
    expect(d.listing.pricePaise).toBe(520);
    expect(d.voiceNote.listingId).toBe(d.listing.id);
    const again = await cat.draftListingFromVoice(biz[0]!, people[0]!, v.id, "en");
    expect(again.listing.id).toBe(d.listing.id);
  });

  it("re-drafts when the linked listing no longer exists; refuses empty transcripts", async () => {
    const v = await cat.createVoiceNote(biz[0]!, people[0]!, { bytes: audio(SAY), mimeType: "audio/ogg" });
    const first = await cat.draftListingFromVoice(biz[0]!, people[0]!, v.id, "hi");
    await prisma.voiceNote.update({ where: { id: v.id }, data: { listingId: randomUUID() } });
    const second = await cat.draftListingFromVoice(biz[0]!, people[0]!, v.id, "hi");
    expect(second.listing.id).not.toBe(first.listing.id);
    const silent = await cat.createVoiceNote(biz[0]!, people[0]!, { bytes: new Uint8Array([1, 2, 3]), mimeType: "audio/ogg" });
    await expect(cat.draftListingFromVoice(biz[0]!, people[0]!, silent.id, "en")).rejects.toMatchObject({ code: "validation" });
    expect(await prisma.reviewItem.count({ where: { subjectType: "voice_note", subjectId: silent.id } })).toBe(1);
  });

  it("queues async transcription and the worker consumer runs it", async () => {
    const v = await cat.createVoiceNote(biz[0]!, people[0]!, { bytes: audio(SAY), mimeType: "audio/ogg" }, { queue: true, language: "hi" });
    const consumer = cat.worker.queues!.find((q) => q.topic === "catalogue.transcribe")!;
    expect(consumer).toBeTruthy();
    const { getJobQueue } = await import("@cnote/core");
    const n = await getJobQueue().consume("catalogue.transcribe", "test", "t1", consumer.handler as never);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await cat.getVoiceNote(biz[0]!, v.id)).transcript).toBe(SAY);
  });

  it("voiceStorage uses private-only listings/_voice keys with media's canonical audio types", () => {
    expect(voiceStorage("id", "audio/ogg")).toEqual({ key: "listings/_voice/id.ogg", contentType: "audio/ogg" });
    expect(voiceStorage("id", "audio/mp4").contentType).toBe("audio/mp4");
  });;

  it("purgeExpiredVoiceNotes deletes only expired audio (dry run counts, failures are skipped)", async () => {
    const mk = async (past: boolean) => {
      const v = await cat.createVoiceNote(biz[1]!, people[2]!, { bytes: audio(SAY), mimeType: "audio/wav" });
      if (past) await prisma.voiceNote.update({ where: { id: v.id }, data: { purgeAfter: new Date(Date.now() - 1000) } });
      return v.id;
    };
    const expired = await mk(true);
    const fresh = await mk(false);
    const now = new Date();
    expect(await cat.purgeExpiredVoiceNotes(now, { dryRun: true })).toBeGreaterThanOrEqual(1);
    const del = vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("s3 down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await cat.purgeExpiredVoiceNotes(now);
    del.mockRestore();
    expect(failed).toBeGreaterThanOrEqual(0);
    await cat.purgeExpiredVoiceNotes(now);
    expect((await prisma.voiceNote.findUniqueOrThrow({ where: { id: expired } })).storageKey).toBeNull();
    expect((await prisma.voiceNote.findUniqueOrThrow({ where: { id: fresh } })).storageKey).not.toBeNull();
  });
});

describe("draftListingFromPhotos", () => {
  it("creates an aiGenerated draft with pending, metadata-free photos and routes to review offline", async () => {
    const a = await solidJpeg(800, 600, [200, 30, 30]);
    const b = await solidJpeg(700, 900, [30, 30, 200]);
    const r = await cat.draftListingFromPhotos(biz[0]!, people[0]!, { files: [{ bytes: a, filename: "a.jpg" }, { bytes: b, filename: "b.jpg" }, { bytes: a, filename: "dup.jpg" }], hintText: SAY, language: "en" });
    expect(r.listing).toMatchObject({ aiGenerated: true, status: "draft", pricePaise: 520, moq: 500 });
    expect(r.ai.needsReview).toBe(true); // heuristic provider has no vision
    expect(r.images).toHaveLength(2);
    expect(r.images.every((i) => i.status === "pending" || i.status === "flagged")).toBe(true);
    expect(r.skipped).toEqual([{ filename: "dup.jpg", reason: expect.stringMatching(/already/) }]);
    const row = await prisma.listingImage.findUniqueOrThrow({ where: { id: r.images[0]!.id } });
    const stored = await store.get(row.storageKey);
    expect(stored!.bytes[0]).toBe(0xff);
    expect(stored!.bytes.length).not.toBe(a.length); // re-encoded, not the original bytes
    expect(await prisma.aiDecision.count({ where: { id: r.ai.decisionId, capability: "extract_image" } })).toBe(1);
  });

  it("works with no hint (untitled placeholder) and portrait images; unknown language falls back to en", async () => {
    const p = await solidJpeg(600, 2000, [10, 200, 10]);
    const r = await cat.draftListingFromPhotos(biz[0]!, people[0]!, { files: [{ bytes: p }], language: "zz" });
    expect(r.listing.title).toBeTruthy();
    expect(r.listing.language).toBe("en");
    expect(r.images).toHaveLength(1);
  });

  it("rejects 0 or 5 photos and invalid files with a friendly message", async () => {
    const ok = await solidJpeg(400, 400);
    await expect(cat.draftListingFromPhotos(biz[0]!, people[0]!, { files: [], language: "en" })).rejects.toMatchObject({ code: "validation" });
    await expect(cat.draftListingFromPhotos(biz[0]!, people[0]!, { files: Array(5).fill({ bytes: ok }), language: "en" })).rejects.toMatchObject({ code: "validation" });
    await expect(cat.draftListingFromPhotos(biz[0]!, people[0]!, { files: [{ bytes: new Uint8Array([1, 2, 3]), filename: "x.gif" }], language: "en" })).rejects.toThrow(/x.gif/);
    await expect(cat.draftListingFromPhotos(biz[0]!, people[0]!, { files: [{ bytes: new Uint8Array(0) }], language: "en" })).rejects.toThrow(/A photo/);
  });

  it("is rate limited per person", async () => {
    const ok = await solidJpeg(400, 400, [1, 2, 3]);
    const person = randomUUID();
    let last: unknown;
    for (let i = 0; i < 21; i++) last = await cat.draftListingFromPhotos(biz[1]!, person, { files: [{ bytes: ok }], language: "en" }).catch((e) => e);
    expect(last).toMatchObject({ code: "rate_limited" });
  });
});
