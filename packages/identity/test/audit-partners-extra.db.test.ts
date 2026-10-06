// T3 partner flow: edge cases, race losers, storage failures and sparse data (ADR-003).
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  assignAuditPartner, auditChecklist, createAuditPartner, evaluateAuditSubmission, getAuditBriefForPartner, getAuditSubmission, issueAuditUploadLink, listAuditPartners,
  listReauditsDue, purgeAuditPhotos, readAuditPhoto, requestAudit, requestAuditResubmission, reviewAuditSubmission, setAuditPartnerActive, setKycPorts, submitAuditByPartner,
  type KycPorts, type PartnerSubmissionInput,
} from "../src";

const tag = randomUUID().slice(0, 6);
const bizIds: string[] = [];
const partnerIds: string[] = [];
const staff = () => randomUUID();
const day = 86_400_000;
const store = new Map<string, Uint8Array>();
const ports = (over: Partial<KycPorts> = {}): KycPorts => ({
  store: { put: async (k, b) => void store.set(k, b), get: async (k) => (store.has(k) ? { bytes: store.get(k)!, contentType: "image/jpeg" } : null), delete: async (k) => void store.delete(k) },
  inspectImage: (b) => ({ mime: "image/jpeg", ext: "jpg", width: 1600, height: 1200, sha256: createHash("sha256").update(b).digest("hex") }),
  extractDocument: async () => { throw new Error("unused"); },
  ...over,
});
const biz = async (o: Record<string, unknown> = {}) => {
  const b = await prisma.business.create({ data: { name: `AuditX ${tag}-${randomUUID().slice(0, 4)}`, verificationTier: 2, registeredAddress: { line1: "12 MIDC Road", city: "Pune", state: "Maharashtra", pincode: "411019" }, ...o } });
  bizIds.push(b.id);
  return b.id;
};
const partner = async (name = `SGS ${tag}`) => { const p = await createAuditPartner({ name }); partnerIds.push(p.id); return p; };
const answers = () => Object.fromEntries(auditChecklist().map((c) => [c.id, { ok: true }]));
const photos = (n = 5): PartnerSubmissionInput["photos"] =>
  Array.from({ length: n }, (_, i) => ({ bytes: new Uint8Array([i, i + 1, Math.floor(Math.random() * 255), 9]), lat: 18.5204 + i * 0.0001, lng: 73.8567, capturedAt: new Date(Date.now() - 3_600_000).toISOString() }));
const submission = (o: Partial<PartnerSubmissionInput> = {}): PartnerSubmissionInput => ({ inspector: "R. Kulkarni", summary: "Premises found, owner present, machines running.", answers: answers(), photos: photos(), ...o });
async function setup(bizOpts: Record<string, unknown> = {}) {
  setKycPorts(ports());
  const b = await biz(bizOpts);
  const p = await partner();
  const a = await requestAudit(b, "pending", staff());
  await assignAuditPartner(a.id, p.id);
  const link = await issueAuditUploadLink(a.id);
  return { b, p, a, link };
}

afterEach(() => { setKycPorts(null); vi.restoreAllMocks(); });
afterAll(async () => {
  const audits = (await prisma.verificationAudit.findMany({ where: { businessId: { in: bizIds } }, select: { id: true } })).map((a) => a.id);
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: audits } }, { aggregateId: { in: bizIds } }] } });
  await prisma.verificationAudit.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.auditPartner.deleteMany({ where: { id: { in: partnerIds } } });
});

describe("auditChecklist config", () => {
  it("rejects malformed overrides and defaults `required` to true", () => {
    const def = auditChecklist({});
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: "   " })).toEqual(def);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: "[]" })).toEqual(def);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: "{}" })).toEqual(def);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: JSON.stringify([{ id: "Bad Id", label: "x" }]) })).toEqual(def);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: JSON.stringify([{ id: "ok_id", label: 7 }]) })).toEqual(def);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: JSON.stringify([{ id: "ok_id", label: "x".repeat(201) }]) })).toEqual(def);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: JSON.stringify([{ id: "a", label: "A" }, { id: "b", label: "B", required: false }]) })).toEqual([
      { id: "a", label: "A", required: true }, { id: "b", label: "B", required: false },
    ]);
  });
});

describe("evaluateAuditSubmission details", () => {
  const checklist = auditChecklist({});
  const now = new Date();
  const ok = Object.fromEntries(checklist.map((c) => [c.id, { ok: true }]));
  const ph = (n: number) => Array.from({ length: n }, (_, i) => ({ sha256: `p${i}`, lat: 18.52, lng: 73.85, capturedAt: now.toISOString() }));
  it("optional items may be unanswered; a failed optional item is flagged but does not fail the checklist", () => {
    const { stock_matches: _s, capacity_plausible: _c, ...required } = ok;
    expect(evaluateAuditSubmission({ checklist, answers: required, photos: ph(4), now })).toMatchObject({ flags: [], checklistPassed: true });
    const failedOptional = evaluateAuditSubmission({ checklist, answers: { ...ok, stock_matches: { ok: false } }, photos: ph(4), now });
    expect(failedOptional.checklistPassed).toBe(true);
    expect(failedOptional.flags[0]).toMatch(/Checklist item failed: Stock/);
    expect(failedOptional.flags[0]).not.toMatch(/\(/);
  });
  it("too few photos fails the checklist; bad, future and stale capture times are flagged", () => {
    expect(evaluateAuditSubmission({ checklist, answers: ok, photos: ph(2), now }).checklistPassed).toBe(false);
    const bad = evaluateAuditSubmission({ checklist, answers: ok, photos: ph(4).map((p, i) => (i === 0 ? { ...p, capturedAt: "garbage" } : p)), now });
    expect(bad.flags).toContain("A photo capture time is in the future or older than 72 hours.");
    const future = evaluateAuditSubmission({ checklist, answers: ok, photos: ph(4).map((p) => ({ ...p, capturedAt: new Date(now.getTime() + 3_600_000).toISOString() })), now });
    expect(future.flags.some((f) => /future/.test(f))).toBe(true);
    const single = evaluateAuditSubmission({ checklist, answers: ok, photos: [{ sha256: "x", lat: 18.5, lng: 73.8, capturedAt: now.toISOString() }], now });
    expect(single.siteRadiusM).toBeNull();
  });
});

describe("partners", () => {
  it("trims names, stores no email when blank, and toggles active; unknown ids are not found", async () => {
    const p = await createAuditPartner({ name: `  Bureau ${tag}  `, contactEmail: "   " });
    partnerIds.push(p.id);
    expect(p).toMatchObject({ name: `Bureau ${tag}`, contactEmail: null, active: true });
    expect((await setAuditPartnerActive(p.id, false)).active).toBe(false);
    expect((await listAuditPartners()).some((x) => x.id === p.id)).toBe(true);
    expect((await listAuditPartners({ activeOnly: true })).some((x) => x.id === p.id)).toBe(false);
    await expect(setAuditPartnerActive(randomUUID(), true)).rejects.toMatchObject({ code: "not_found" });
    await expect(createAuditPartner({ name: "x".repeat(121) })).rejects.toMatchObject({ code: "validation" });
  });
  it("assign: unknown partner and decided audits are refused", async () => {
    setKycPorts(ports());
    const b = await biz();
    const a = await requestAudit(b, "x", staff());
    await expect(assignAuditPartner(a.id, randomUUID())).rejects.toMatchObject({ code: "validation" });
    const p = await partner();
    await expect(assignAuditPartner(randomUUID(), p.id)).rejects.toThrow();
    await prisma.verificationAudit.update({ where: { id: a.id }, data: { status: "cancelled" } });
    await expect(assignAuditPartner(a.id, p.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(issueAuditUploadLink(a.id)).rejects.toThrow();
    await prisma.verificationAudit.update({ where: { id: a.id }, data: { status: "scheduled", partnerId: p.id } });
    await prisma.verificationAudit.update({ where: { id: a.id }, data: { status: "cancelled" } });
    await expect(issueAuditUploadLink(a.id)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("partner brief", () => {
  it("builds the address from city/state/pincode when no structured address, and null when nothing is known", async () => {
    const withCity = await setup({ registeredAddress: null, city: "Surat", state: "Gujarat", pincode: "395003", legalName: "Surat Textiles Pvt Ltd" });
    const brief = await getAuditBriefForPartner(withCity.link.token);
    expect(brief).toMatchObject({ address: "Surat, Gujarat, 395003", businessName: "Surat Textiles Pvt Ltd", scheduledFor: null });
    const none = await setup({ registeredAddress: null });
    expect((await getAuditBriefForPartner(none.link.token)).address).toBeNull();
    const scheduled = await setup();
    const when = new Date(Date.now() + 2 * day);
    await prisma.verificationAudit.update({ where: { id: scheduled.a.id }, data: { scheduledFor: when, status: "scheduled" } });
    expect((await getAuditBriefForPartner(scheduled.link.token)).scheduledFor).toBe(when.toISOString());
  });
});

describe("submitAuditByPartner", () => {
  it("rejects too many photos, bad longitude and non-image bytes (Error and non-Error)", async () => {
    const { link } = await setup();
    await expect(submitAuditByPartner(link.token, submission({ photos: photos(13) }))).rejects.toThrow(/between 1 and 12/);
    await expect(submitAuditByPartner(link.token, submission({ photos: [{ bytes: new Uint8Array([1]), lat: 1, lng: 200, capturedAt: null }] }))).rejects.toThrow(/invalid location/);
    setKycPorts(ports({ inspectImage: () => { throw new Error("Not a JPEG"); } }));
    await expect(submitAuditByPartner(link.token, submission())).rejects.toThrow(/Not a JPEG/);
    setKycPorts(ports({ inspectImage: () => { throw "weird"; } }));
    await expect(submitAuditByPartner(link.token, submission())).rejects.toThrow(/not a valid image/);
  });
  it("keeps only known checklist answers, truncates notes and records failed answers", async () => {
    const { a, link } = await setup();
    const out = await submitAuditByPartner(link.token, submission({ answers: { ...answers(), premises_exist: { ok: false, note: "n".repeat(500) }, unknown_item: { ok: true }, owner_present: { ok: "yes" as never } }, photos: photos(4) }));
    expect(out.flags.some((f) => /Checklist item failed: Premises/.test(f))).toBe(true);
    const row = await prisma.verificationAudit.findUniqueOrThrow({ where: { id: a.id } });
    const answersStored = (row.submission as { answers: Record<string, { ok: boolean; note?: string }> }).answers;
    expect(answersStored.unknown_item).toBeUndefined();
    expect(answersStored.premises_exist!.note).toHaveLength(300);
    expect(answersStored.owner_present).toEqual({ ok: false });
  });
  it("accepts photos without geotags; unanswered required items are flagged", async () => {
    const { link } = await setup();
    const out = await submitAuditByPartner(link.token, submission({ answers: {}, photos: photos(4).map((p) => ({ ...p, lat: null, lng: null, capturedAt: null })) }));
    expect(out.flags.join("|")).toMatch(/not answered/);
    expect(out.flags.join("|")).toMatch(/no location/);
  });
  it("deletes already-stored photos when a later store write fails", async () => {
    const { link } = await setup();
    const before = store.size;
    let n = 0;
    setKycPorts(ports({ store: { put: async (k, b) => { if (++n === 3) throw new Error("disk full"); store.set(k, b); }, get: async () => null, delete: async (k) => void store.delete(k) } }));
    await expect(submitAuditByPartner(link.token, submission())).rejects.toThrow(/disk full/);
    expect(store.size).toBe(before);
  });
  it("loses a claim race with a conflict and cleans up its photos (delete errors are ignored)", async () => {
    const { a, link } = await setup();
    const before = store.size;
    setKycPorts(ports({ store: { put: async (k, b) => { store.set(k, b); await prisma.verificationAudit.update({ where: { id: a.id }, data: { status: "cancelled" } }); }, get: async () => null, delete: async (k) => { store.delete(k); throw new Error("already gone"); } } }));
    await expect(submitAuditByPartner(link.token, submission())).rejects.toMatchObject({ code: "conflict" });
    expect(store.size).toBe(before);
  });
});

describe("staff review helpers", () => {
  it("getAuditSubmission is null before a submission; checklist answers default to null", async () => {
    const { a, link } = await setup();
    expect(await getAuditSubmission(a.id)).toBeNull();
    expect(await readAuditPhoto(a.id, 0)).toBeNull();
    await submitAuditByPartner(link.token, submission({ answers: { premises_exist: { ok: true, note: "board visible" } } }));
    const sub = (await getAuditSubmission(a.id))!;
    expect(sub.checklist.find((c) => c.id === "premises_exist")).toMatchObject({ ok: true, note: "board visible" });
    expect(sub.checklist.find((c) => c.id === "owner_present")).toMatchObject({ ok: null, note: null });
    expect(await readAuditPhoto(a.id, 99)).toBeNull();
  });
  it("review requires a submitted audit", async () => {
    const { a } = await setup();
    await expect(reviewAuditSubmission(a.id, { result: "pass", validUntil: new Date(Date.now() + day), note: "n" }, staff())).rejects.toMatchObject({ code: "conflict" });
  });
  it("resubmission: needs a submitted audit, tolerates photos without keys, and detects a decided race", async () => {
    const { a, link } = await setup();
    await expect(requestAuditResubmission(a.id, "note")).rejects.toMatchObject({ code: "conflict" });
    await submitAuditByPartner(link.token, submission());
    await prisma.verificationAudit.update({ where: { id: a.id }, data: { submission: { inspector: "x", summary: "y", answers: {}, flags: [], checklistPassed: true, siteRadiusM: null, photos: [{ lat: null, lng: null, capturedAt: null }] } } });
    vi.spyOn(prisma.verificationAudit, "updateMany").mockResolvedValueOnce({ count: 0 });
    await expect(requestAuditResubmission(a.id, "redo")).rejects.toMatchObject({ code: "conflict" });
    const back = await requestAuditResubmission(a.id, "redo");
    expect(back.status).toBe("scheduled");
  });
  it("resubmission ignores photo-deletion failures", async () => {
    const { a, link } = await setup();
    await submitAuditByPartner(link.token, submission());
    setKycPorts(ports({ store: { put: async (k, b) => void store.set(k, b), get: async () => null, delete: async () => { throw new Error("store offline"); } } }));
    expect((await requestAuditResubmission(a.id, "redo")).status).toBe("scheduled");
  });
  it("a failing review records the result and nothing is due for re-audit", async () => {
    const { a, link } = await setup();
    await submitAuditByPartner(link.token, submission());
    const done = await reviewAuditSubmission(a.id, { result: "fail", validUntil: new Date(Date.now() + 365 * day), note: "ok" }, staff());
    expect(done.status).toBe("failed");
    expect(await listReauditsDue(new Date(0))).toEqual([]);
  });
});

describe("purgeAuditPhotos", () => {
  it("ignores decided audits without photos and photos without a stored key", async () => {
    const { a } = await setup();
    await prisma.verificationAudit.update({ where: { id: a.id }, data: { status: "failed", submission: { photos: [{ lat: 1, lng: 1, capturedAt: null }, { key: "kyc/audit/none", lat: 1, lng: 1, capturedAt: null }] } } });
    const nullSub = await setup();
    await prisma.verificationAudit.update({ where: { id: nullSub.a.id }, data: { status: "expired" } });
    const cutoff = new Date(Date.now() + day);
    expect(await purgeAuditPhotos(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    setKycPorts(ports({ store: { put: async () => {}, get: async () => null, delete: async () => { throw new Error("gone"); } } }));
    await purgeAuditPhotos(cutoff);
    const row = await prisma.verificationAudit.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.submission).toMatchObject({ photos: [], photosPurged: 2 });
  });
});
