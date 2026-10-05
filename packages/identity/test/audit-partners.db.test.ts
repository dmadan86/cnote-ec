// T3 partner-submission flow: assignment, single-use signed link, checklist + geotagged photos, review, re-audit date, retention.
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  assignAuditPartner, auditChecklist, createAuditPartner, evaluateAuditSubmission, expireAudits, getAuditBriefForPartner, getAuditSubmission, haversineM, issueAuditUploadLink,
  listAudits, listAuditPartners, listReauditsDue, purgeAuditPhotos, readAuditPhoto, requestAudit, requestAuditResubmission, reviewAuditSubmission, scheduleAudit, setAuditPartnerActive,
  setKycPorts, submitAuditByPartner, type KycPorts, type PartnerSubmissionInput,
} from "../src";

const tag = randomUUID().slice(0, 6);
const bizIds: string[] = [];
const partnerIds: string[] = [];
const staff = () => randomUUID();
const day = 86_400_000;
const store = new Map<string, Uint8Array>();
const ports = (): KycPorts => ({
  store: { put: async (k, b) => void store.set(k, b), get: async (k) => (store.has(k) ? { bytes: store.get(k)!, contentType: "image/jpeg" } : null), delete: async (k) => void store.delete(k) },
  inspectImage: (b) => ({ mime: "image/jpeg", ext: "jpg", width: 1600, height: 1200, sha256: createHash("sha256").update(b).digest("hex") }),
  extractDocument: async () => { throw new Error("unused"); },
});
const biz = async () => {
  const b = await prisma.business.create({ data: { name: `Audit ${tag}-${randomUUID().slice(0, 4)}`, verificationTier: 2, registeredAddress: { line1: "12 MIDC Road", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411019" } } });
  bizIds.push(b.id);
  return b.id;
};
const partner = async () => { const p = await createAuditPartner({ name: `SGS ${tag}`, contactEmail: "ops@sgs.test" }); partnerIds.push(p.id); return p; };
const answers = () => Object.fromEntries(auditChecklist().map((c) => [c.id, { ok: true }]));
const photos = (n = 5, lat = 18.5204, lng = 73.8567): PartnerSubmissionInput["photos"] =>
  Array.from({ length: n }, (_, i) => ({ bytes: new Uint8Array([i, i + 1, Math.floor(Math.random() * 255), 7]), lat: lat + i * 0.0001, lng: lng + i * 0.0001, capturedAt: new Date(Date.now() - 3600_000).toISOString() }));
const submission = (o: Partial<PartnerSubmissionInput> = {}): PartnerSubmissionInput => ({ inspector: "R. Kulkarni", summary: "Premises found, owner present, machines running.", answers: answers(), photos: photos(), ...o });
async function setup() {
  setKycPorts(ports());
  const b = await biz();
  const p = await partner();
  const a = await requestAudit(b, "pending", staff());
  await assignAuditPartner(a.id, p.id);
  const link = await issueAuditUploadLink(a.id);
  return { b, p, a, link };
}

afterEach(() => setKycPorts(null));
afterAll(async () => {
  const audits = (await prisma.verificationAudit.findMany({ where: { businessId: { in: bizIds } }, select: { id: true } })).map((a) => a.id);
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: audits } }, { aggregateId: { in: bizIds } }] } });
  await prisma.verificationAudit.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.auditPartner.deleteMany({ where: { id: { in: partnerIds } } });
});

describe("evaluateAuditSubmission (pure)", () => {
  const checklist = auditChecklist();
  const now = new Date();
  const ph = (n: number, over: object = {}) => Array.from({ length: n }, (_, i) => ({ sha256: `h${i}`, lat: 18.52 + i * 0.0001, lng: 73.85, capturedAt: now.toISOString(), ...over }));
  it("clean submission has no flags", () => expect(evaluateAuditSubmission({ checklist, answers: Object.fromEntries(checklist.map((c) => [c.id, { ok: true }])), photos: ph(5), now })).toMatchObject({ flags: [], checklistPassed: true }));
  it("flags missing required answers, failed items, few/duplicate/untagged/foreign/scattered/old photos", () => {
    const e = evaluateAuditSubmission({ checklist, answers: { premises_exist: { ok: false, note: "locked" } }, photos: [{ sha256: "a", lat: null, lng: null, capturedAt: null }, { sha256: "a", lat: 51.5, lng: -0.12, capturedAt: new Date(now.getTime() - 10 * day).toISOString() }], now });
    expect(e.checklistPassed).toBe(false);
    expect(e.flags.join("|")).toMatch(/not answered|failed.*locked|Only 2 photos|more than once|no location|outside India|no capture time|older than 72/);
    const far = evaluateAuditSubmission({ checklist, answers: Object.fromEntries(checklist.map((c) => [c.id, { ok: true }])), photos: [...ph(4), { sha256: "z", lat: 19.5, lng: 73.85, capturedAt: now.toISOString() }], now });
    expect(far.flags.some((f) => /apart/.test(f))).toBe(true);
    expect(far.siteRadiusM).toBeGreaterThan(300);
  });
  it("haversine is sane and the checklist can be overridden by env config", () => {
    expect(Math.round(haversineM({ lat: 18.52, lng: 73.85 }, { lat: 18.52, lng: 73.86 }))).toBeGreaterThan(1000);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: JSON.stringify([{ id: "cold_chain", label: "Cold chain logs", required: true }]) })).toEqual([{ id: "cold_chain", label: "Cold chain logs", required: true }]);
    expect(auditChecklist({ AUDIT_CHECKLIST_JSON: "nope" })).toEqual(auditChecklist({}));
  });
});

describe("partner submission flow", () => {
  it("assign -> link -> brief -> submit -> review pass: tier 3, re-audit date, badge reflects tier", async () => {
    const { b, a, link } = await setup();
    const brief = await getAuditBriefForPartner(link.token);
    expect(brief).toMatchObject({ auditId: a.id, minPhotos: 4 });
    expect(brief.address).toContain("MIDC");
    const out = await submitAuditByPartner(link.token, submission());
    expect(out.flags).toEqual([]);
    expect((await listAudits({ businessId: b }))[0]).toMatchObject({ status: "submitted", submission: { photoCount: 5, checklistPassed: true } });
    expect(await prisma.domainEvent.count({ where: { aggregateId: a.id, type: "AuditSubmitted" } })).toBe(1);
    // single use
    await expect(submitAuditByPartner(link.token, submission())).rejects.toThrow(/not valid/);
    await expect(getAuditBriefForPartner(link.token)).rejects.toThrow();
    const sub = await getAuditSubmission(a.id);
    expect(sub?.photos).toHaveLength(5);
    expect((await readAuditPhoto(a.id, 0))?.bytes.length).toBeGreaterThan(0);

    await expect(reviewAuditSubmission(a.id, { result: "pass", validUntil: new Date(Date.now() + 365 * day), note: " " }, staff())).rejects.toThrow(/note/);
    const validUntil = new Date(Date.now() + 365 * day);
    const done = await reviewAuditSubmission(a.id, { result: "pass", validUntil, note: "Site visit consistent." }, staff());
    expect(done).toMatchObject({ status: "completed", result: "pass", reviewNote: "Site visit consistent." });
    expect(Date.parse(done.reAuditDueAt!)).toBe(validUntil.getTime() - 30 * day);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).verificationTier).toBe(3);
    // other files create passing audits concurrently, so assert on this audit only
    expect((await listReauditsDue(new Date(validUntil.getTime() - 10 * day))).map((x) => x.id)).toContain(a.id);
    expect((await listReauditsDue()).map((x) => x.id)).not.toContain(a.id);
    // expiry returns to T2
    expect(await expireAudits(new Date(validUntil.getTime() + day))).toBeGreaterThanOrEqual(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).verificationTier).toBe(2);
  });

  it("guards: partner required, expired link, replaced link, inactive partner, bad inputs", async () => {
    setKycPorts(ports());
    const b = await biz();
    const a = await requestAudit(b, "x", staff());
    await expect(issueAuditUploadLink(a.id)).rejects.toThrow(/Assign/);
    const p = await partner();
    await assignAuditPartner(a.id, p.id);
    const old = await issueAuditUploadLink(a.id);
    const fresh = await issueAuditUploadLink(a.id);
    await expect(getAuditBriefForPartner(old.token)).rejects.toThrow();
    await expect(getAuditBriefForPartner(fresh.token, new Date(Date.now() + 15 * day))).rejects.toThrow(/expired|valid/);
    await expect(getAuditBriefForPartner("short")).rejects.toThrow();
    await expect(submitAuditByPartner(fresh.token, submission({ inspector: "" }))).rejects.toThrow(/inspector/);
    await expect(submitAuditByPartner(fresh.token, submission({ summary: "ok" }))).rejects.toThrow(/summary/);
    await expect(submitAuditByPartner(fresh.token, submission({ photos: [] }))).rejects.toThrow(/photos/);
    await expect(submitAuditByPartner(fresh.token, submission({ photos: [{ bytes: new Uint8Array(7 * 1024 * 1024), lat: 1, lng: 1, capturedAt: null }] }))).rejects.toThrow(/6 MB/);
    await expect(submitAuditByPartner(fresh.token, submission({ photos: [{ bytes: new Uint8Array([1]), lat: 99, lng: 1, capturedAt: null }] }))).rejects.toThrow(/location/);
    await setAuditPartnerActive(p.id, false);
    expect(await listAuditPartners({ activeOnly: true })).not.toContainEqual(expect.objectContaining({ id: p.id }));
    await expect(assignAuditPartner(a.id, p.id)).rejects.toThrow(/active/);
    await expect(createAuditPartner({ name: "x" })).rejects.toThrow();
    await expect(createAuditPartner({ name: "Valid Name", contactEmail: "bad" })).rejects.toThrow(/email/);
  });

  it("flagged submission can be sent back (photos deleted), resubmitted, and a fail leaves the tier", async () => {
    const { b, a, link } = await setup();
    const flagged = await submitAuditByPartner(link.token, submission({ photos: photos(2) }));
    expect(flagged.flags.some((f) => /Only 2 photos/.test(f))).toBe(true);
    const before = store.size;
    await expect(requestAuditResubmission(a.id, " ")).rejects.toThrow(/note/);
    const back = await requestAuditResubmission(a.id, "Need at least four photos.");
    expect(back).toMatchObject({ status: "scheduled", submission: null });
    expect(store.size).toBe(before - 2);
    const again = await issueAuditUploadLink(a.id);
    await submitAuditByPartner(again.token, submission());
    const failed = await reviewAuditSubmission(a.id, { result: "fail", validUntil: new Date(Date.now() + day), note: "Premises not as declared." }, staff());
    expect(failed).toMatchObject({ status: "failed", result: "fail", reAuditDueAt: null });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).verificationTier).toBe(2);
    await expect(reviewAuditSubmission(a.id, { result: "pass", validUntil: new Date(Date.now() + day), note: "x" }, staff())).rejects.toThrow(/no partner submission/);
    await expect(scheduleAudit(a.id, new Date(Date.now() + day), staff())).rejects.toThrow(/Only requested or scheduled/);
  });

  it("retention purge deletes decided audits' photos but keeps the checklist record", async () => {
    const { a, link } = await setup();
    await submitAuditByPartner(link.token, submission());
    await reviewAuditSubmission(a.id, { result: "pass", validUntil: new Date(Date.now() + 365 * day), note: "ok" }, staff());
    expect(await purgeAuditPhotos(new Date(Date.now() - day))).toBe(0);
    const cutoff = new Date(Date.now() + day);
    expect(await purgeAuditPhotos(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await purgeAuditPhotos(cutoff)).toBeGreaterThanOrEqual(1);
    const row = await prisma.verificationAudit.findUniqueOrThrow({ where: { id: a.id } });
    expect((row.submission as { photos: unknown[]; photosPurged: number }).photos).toHaveLength(0);
    expect((row.submission as { photosPurged: number }).photosPurged).toBe(5);
    expect((row.submission as { summary: string }).summary).toMatch(/Premises found/);
  });
});
