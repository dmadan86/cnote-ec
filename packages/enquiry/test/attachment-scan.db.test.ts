// Malware scanning, quarantine and retention of RFQ / quote attachments (ai_ops; docs/design/attachment-scanning.md).
import { prisma } from "@cnote/db";
import { EICAR_TEST_STRING, LocalMediaStore, ScanUnavailableError, setAttachmentScannerForTests, setMediaStore } from "@cnote/media";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { attachmentsEnabled, checkAttachments, exportPersonalData, purgeAttachmentQuarantine, purgeEndedEnquiryAttachments, storeAttachmentBytes, discardStored } from "../src";

const tag = randomUUID().slice(0, 8);
const day = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * day);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 10, 10]);
const infected = new Uint8Array([...PDF, ...Buffer.from(EICAR_TEST_STRING, "latin1")]);
const file = (bytes: Uint8Array, name = "a.pdf") => ({ fileName: name, bytes, mime: "application/pdf" as const, ext: "pdf" as const });

let dir: string;
let store: LocalMediaStore;
let actor: { personId: string; businessId: string };
const enquiryIds: string[] = [];
const bizIds: string[] = [];
const personIds: string[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "scan-media-"));
  store = new LocalMediaStore(dir, "private");
  setMediaStore(store, "private");
  const p = await prisma.person.create({ data: { name: `scan-${tag}` } });
  const b = await prisma.business.create({ data: { name: `scan-${tag}` } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  actor = { personId: p.id, businessId: b.id };
  personIds.push(p.id);
  bizIds.push(b.id);
});
afterEach(() => { setAttachmentScannerForTests(null); vi.restoreAllMocks(); delete process.env.RFQ_ATTACHMENTS_ENABLED; });
afterAll(async () => {
  setMediaStore(undefined);
  rmSync(dir, { recursive: true, force: true });
  await prisma.enquiryAttachment.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.attachmentQuarantine.deleteMany({ where: { uploadedByBusiness: { in: bizIds } } });
  await prisma.order.deleteMany({ where: { enquiryId: { in: enquiryIds } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiryIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE payload->>'uploadedByBusinessId' = ANY(${bizIds})`;
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("scan on upload", () => {
  it("stores clean files with scan evidence", async () => {
    const eid = randomUUID();
    const stored = await storeAttachmentBytes(eid, [file(PDF)], { actor, kind: "rfq" });
    expect(stored[0]).toMatchObject({ scanner: "mock" });
    expect(stored[0]!.scannedAt).toBeInstanceOf(Date);
    expect(await store.exists(stored[0]!.key)).toBe(true);
    await discardStored(stored);
  });

  it("an infected file is quarantined, recorded, announced and rejects the whole upload; nothing becomes visible", async () => {
    const eid = randomUUID();
    await expect(storeAttachmentBytes(eid, [file(PDF, "ok.pdf"), file(infected, "evil.pdf")], { actor, kind: "quote" })).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/blocked by our security scan/) });
    // the clean sibling was not written either (scan happens before any write)
    expect(await prisma.enquiryAttachment.count({ where: { enquiryId: eid } })).toBe(0);
    const q = await prisma.attachmentQuarantine.findFirstOrThrow({ where: { enquiryId: eid } });
    expect(q).toMatchObject({ kind: "quote", uploadedByBusiness: actor.businessId, uploadedByPerson: actor.personId, fileName: "evil.pdf", signature: "Eicar-Test-Signature", scanner: "mock", purgedAt: null });
    expect(q.key.startsWith(`rfq/quarantine/${eid}/`)).toBe(true);
    expect(await store.exists(q.key)).toBe(true);
    const ev = await prisma.$queryRaw<{ type: string; payload: Record<string, unknown> }[]>`SELECT type, payload FROM domain_events WHERE type = 'AttachmentQuarantined' AND aggregate_id = ${eid}`;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ quarantineId: q.id, kind: "quote", uploadedByPersonId: actor.personId });
    expect(JSON.stringify(ev[0]!.payload)).not.toMatch(/evil\.pdf/); // no file name in the event
  });

  it("fails closed when the scanner cannot answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setAttachmentScannerForTests({ name: "down", scan: async () => { throw new ScanUnavailableError("clamd down"); } });
    const eid = randomUUID();
    await expect(storeAttachmentBytes(eid, [file(PDF)], { actor, kind: "rfq" })).rejects.toMatchObject({ code: "conflict", message: expect.stringMatching(/try again/) });
    expect(await prisma.attachmentQuarantine.count({ where: { enquiryId: eid } })).toBe(0);
    expect(await store.exists(`rfq/${eid}/x.pdf`)).toBe(false);
  });

  it("fails closed when the configured scanner is misconfigured", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const saved = { s: process.env.ATTACHMENT_SCANNER, h: process.env.CLAMAV_HOST };
    process.env.ATTACHMENT_SCANNER = "clamav";
    delete process.env.CLAMAV_HOST;
    try {
      await expect(storeAttachmentBytes(randomUUID(), [file(PDF)], { actor, kind: "rfq" })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      if (saved.s === undefined) delete process.env.ATTACHMENT_SCANNER; else process.env.ATTACHMENT_SCANNER = saved.s;
      if (saved.h !== undefined) process.env.CLAMAV_HOST = saved.h;
    }
  });

  it("still blocks when the quarantine copy cannot be written (no bytes kept, row marked purged)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const real = store.put.bind(store);
    store.put = async () => { throw new Error("disk full"); };
    const eid = randomUUID();
    try {
      await expect(storeAttachmentBytes(eid, [file(infected)], { actor, kind: "rfq" })).rejects.toMatchObject({ code: "validation" });
    } finally {
      store.put = real;
    }
    expect((await prisma.attachmentQuarantine.findFirstOrThrow({ where: { enquiryId: eid } })).purgedAt).toBeInstanceOf(Date);
  });
});

describe("RFQ_ATTACHMENTS_ENABLED", () => {
  it("rejects files when off, still allows none", () => {
    expect(attachmentsEnabled({})).toBe(true);
    for (const off of ["false", "0", "no", "OFF"]) expect(attachmentsEnabled({ RFQ_ATTACHMENTS_ENABLED: off })).toBe(false);
    process.env.RFQ_ATTACHMENTS_ENABLED = "false";
    expect(() => checkAttachments([{ fileName: "a.pdf", bytes: PDF }], 5, 1000)).toThrow(/temporarily unavailable/);
    expect(checkAttachments([], 5, 1000)).toEqual([]);
    expect(checkAttachments(null, 5, 1000)).toEqual([]);
  });
});

async function enquiryWithAttachment(over: { expiresAt?: Date | null; createdAt?: Date; status?: "matched" | "closed" | "rejected" | "unmatched" } = {}) {
  const e = await prisma.enquiry.create({
    data: { buyerBusinessId: actor.businessId, buyerPersonId: actor.personId, title: `t-${tag}`, requirement: "r", expiresAt: over.expiresAt ?? null, createdAt: over.createdAt ?? new Date(), status: over.status ?? "matched" },
  });
  enquiryIds.push(e.id);
  const stored = await storeAttachmentBytes(e.id, [file(PDF)], { actor, kind: "rfq" });
  await prisma.enquiryAttachment.create({ data: { id: stored[0]!.id, enquiryId: e.id, uploadedByBusiness: actor.businessId, key: stored[0]!.key, fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: PDF.length, scannedAt: stored[0]!.scannedAt, scanner: "mock" } });
  return { enquiry: e, key: stored[0]!.key, id: stored[0]!.id };
}

describe("retention", () => {
  it("purges attachments (bytes and rows) 365 days after the quote deadline; leaves recent, future and open ones; idempotent; dry-run counts", async () => {
    const cutoff = ago(365);
    const old = await enquiryWithAttachment({ expiresAt: ago(400), createdAt: ago(430) });
    const recent = await enquiryWithAttachment({ expiresAt: ago(10), createdAt: ago(40) });
    const live = await enquiryWithAttachment({ expiresAt: new Date(Date.now() + 5 * day) });
    const legacyOpen = await enquiryWithAttachment({ createdAt: ago(500), status: "matched" }); // no deadline and not ended: kept
    const legacyEnded = await enquiryWithAttachment({ createdAt: ago(500), status: "closed" });

    expect(await purgeEndedEnquiryAttachments(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect(await store.exists(old.key)).toBe(true);

    expect(await purgeEndedEnquiryAttachments(cutoff)).toBeGreaterThanOrEqual(2);
    for (const gone of [old, legacyEnded]) {
      expect(await store.exists(gone.key)).toBe(false);
      expect(await prisma.enquiryAttachment.count({ where: { id: gone.id } })).toBe(0);
    }
    for (const kept of [recent, live, legacyOpen]) {
      expect(await store.exists(kept.key)).toBe(true);
      expect(await prisma.enquiryAttachment.count({ where: { id: kept.id } })).toBe(1);
    }
    expect(await purgeEndedEnquiryAttachments(cutoff)).toBe(0);
  });

  it("keeps the attachments of a requirement that became an order for a further 730 days", async () => {
    const withOrder = await enquiryWithAttachment({ expiresAt: ago(400), createdAt: ago(430) });
    await prisma.order.create({ data: { enquiryId: withOrder.enquiry.id, buyerBusinessId: actor.businessId, sellerBusinessId: actor.businessId, createdAt: ago(380) } });
    await purgeEndedEnquiryAttachments(ago(365));
    expect(await store.exists(withOrder.key)).toBe(true);
    // far in the future the order is older than the grace window too
    await purgeEndedEnquiryAttachments(ago(365 - 1000));
    expect(await store.exists(withOrder.key)).toBe(false);
  });

  it("purges quarantined bytes after the window but keeps the audit row", async () => {
    const eid = randomUUID();
    await expect(storeAttachmentBytes(eid, [file(infected)], { actor, kind: "rfq" })).rejects.toBeTruthy();
    const q = await prisma.attachmentQuarantine.findFirstOrThrow({ where: { enquiryId: eid } });
    await prisma.attachmentQuarantine.update({ where: { id: q.id }, data: { detectedAt: ago(40) } });
    expect(await purgeAttachmentQuarantine(ago(30), { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await store.exists(q.key)).toBe(true);
    expect(await purgeAttachmentQuarantine(ago(30))).toBeGreaterThanOrEqual(1);
    expect(await store.exists(q.key)).toBe(false);
    expect((await prisma.attachmentQuarantine.findUniqueOrThrow({ where: { id: q.id } })).purgedAt).toBeInstanceOf(Date);
    expect(await purgeAttachmentQuarantine(ago(30))).toBe(0);
  });
});

describe("DPDP export", () => {
  it("lists attachments with scan results and blocked uploads, never storage keys", async () => {
    const e = await enquiryWithAttachment({ expiresAt: new Date(Date.now() + day) });
    await expect(storeAttachmentBytes(randomUUID(), [file(infected, "bad.pdf")], { actor, kind: "rfq" })).rejects.toBeTruthy();
    const out = (await exportPersonalData(actor.personId, { businessIds: [actor.businessId] } as never)) as Record<string, { items?: Record<string, unknown>[] }>;
    const att = out.attachments!.items!.find((a) => a.id === e.id)!;
    expect(att).toMatchObject({ scanner: "mock" });
    expect(att.scannedAt).toBeTruthy();
    const quarantined = out.quarantinedAttachments!.items!;
    expect(quarantined.some((q) => q.fileName === "bad.pdf" && q.signature === "Eicar-Test-Signature")).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/rfq\/quarantine|"key"/);
  });
});
