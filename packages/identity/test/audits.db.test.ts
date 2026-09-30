import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  auditWorkerJobs, cancelAudit, expireAudits, listAudits, readAuditReport, recordAuditResult, requestAudit, scheduleAudit, setKycPorts,
  type KycPorts,
} from "../src";

const tag = randomUUID().slice(0, 6);
const bizIds: string[] = [];
const staff = () => randomUUID();
const day = 86_400_000;
const future = (d = 365) => new Date(Date.now() + d * day);
const store = new Map<string, Uint8Array>();
const ports = (): KycPorts => ({
  store: { put: async (k, b) => void store.set(k, b), get: async (k) => (store.has(k) ? { bytes: store.get(k)!, contentType: "application/zip" } : null), delete: async (k) => void store.delete(k) },
  inspectImage: () => { throw new Error("unused"); }, extractDocument: async () => { throw new Error("unused"); },
});
const biz = async (tier = 2) => {
  const b = await prisma.business.create({ data: { name: `Audit ${tag}-${randomUUID().slice(0, 4)}`, verificationTier: tier, isSeller: false } });
  bizIds.push(b.id);
  return b.id;
};
afterEach(() => setKycPorts(null));
afterAll(async () => {
  const audits = (await prisma.verificationAudit.findMany({ where: { businessId: { in: bizIds } }, select: { id: true } })).map((a) => a.id);
  await prisma.domainEvent.deleteMany({ where: { OR: [{ aggregateId: { in: audits } }, { aggregateId: { in: bizIds } }] } });
  await prisma.verificationAudit.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.verificationRecord.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
});

describe("T3 audits", () => {
  it("request → schedule → pass: tier 3, record, events, report stored privately", async () => {
    setKycPorts(ports());
    const b = await biz();
    const a = await requestAudit(b, " SGS India ", staff());
    expect(a).toMatchObject({ partner: "SGS India", status: "requested" });
    await expect(requestAudit(b, "TUV", staff())).rejects.toThrow(/open audit/);
    await expect(scheduleAudit(a.id, new Date(Date.now() - 1000), staff())).rejects.toThrow(/future/);
    const sch = await scheduleAudit(a.id, future(7), staff());
    expect(sch.status).toBe("scheduled");
    expect((await scheduleAudit(a.id, future(9), staff())).scheduledFor).not.toBe(sch.scheduledFor);

    const done = await recordAuditResult(a.id, { result: "pass", findings: { premises: "ok" }, reportBytes: new Uint8Array([1, 2, 3]), reportMime: "application/zip", validUntil: future() }, staff());
    expect(done).toMatchObject({ status: "completed", result: "pass", hasReport: true });
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).verificationTier).toBe(3);
    expect(await prisma.verificationRecord.count({ where: { businessId: b, kind: "audit", status: "passed", tier: 3 } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { aggregateId: a.id, type: "AuditCompleted" } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { aggregateId: b, type: "BusinessVerified" } })).toBe(1);
    const key = [...store.keys()].find((k) => k.includes(a.id))!;
    expect(key).toMatch(/^kyc\/audit\//); // private-only prefix in @cnote/media
    expect((await readAuditReport(a.id))!.bytes).toEqual(new Uint8Array([1, 2, 3]));
    await expect(recordAuditResult(a.id, { result: "pass", findings: {}, validUntil: future() }, staff())).rejects.toThrow(/already/);
    await expect(scheduleAudit(a.id, future(3), staff())).rejects.toThrow(/Only requested/);
    await expect(cancelAudit(a.id)).rejects.toThrow(/open audits/);
  });

  it("fail / conditional do not lift the tier; validation guards", async () => {
    const b = await biz();
    const a = await requestAudit(b, "Local Agency", staff());
    await expect(recordAuditResult(a.id, { result: "pass", findings: {}, validUntil: new Date(Date.now() - 1000) }, staff())).rejects.toThrow(/future/);
    await expect(recordAuditResult(a.id, { result: "fail", findings: {}, reportBytes: new Uint8Array([1]), reportMime: "text/html", validUntil: future() }, staff())).rejects.toThrow(/image or a zip/);
    const f = await recordAuditResult(a.id, { result: "fail", findings: { why: "no premises" }, validUntil: future() }, staff());
    expect(f.status).toBe("failed");
    expect(f.hasReport).toBe(false);
    expect(await readAuditReport(a.id)).toBeNull();
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).verificationTier).toBe(2);
    const c = await requestAudit(b, "Local Agency", staff());
    const cond = await recordAuditResult(c.id, { result: "conditional", findings: {}, validUntil: future() }, staff());
    expect(cond.status).toBe("completed");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).verificationTier).toBe(2);
    expect(await prisma.verificationRecord.count({ where: { businessId: b, kind: "audit", status: "pending" } })).toBe(1);
  });

  it("request guards: partner, business, tier; cancel; unknown audit", async () => {
    await expect(requestAudit(await biz(), "  ", staff())).rejects.toThrow(/partner/);
    await expect(requestAudit(randomUUID(), "SGS", staff())).rejects.toThrow(/not found/);
    await expect(requestAudit(await biz(1), "SGS", staff())).rejects.toThrow(/Tier 2/);
    const b = await biz();
    const a = await requestAudit(b, "SGS", staff());
    expect((await cancelAudit(a.id)).status).toBe("cancelled");
    expect((await requestAudit(b, "SGS", staff())).status).toBe("requested"); // cancelled no longer blocks
    await expect(cancelAudit(randomUUID())).rejects.toThrow(/not found/);
  });

  it("listAudits filters by business and status", async () => {
    const b = await biz();
    await requestAudit(b, "SGS", staff());
    const all = await listAudits({ businessId: b });
    expect(all).toHaveLength(1);
    expect(all[0]!.businessName).toMatch(/^Audit/);
    expect(await listAudits({ businessId: b, status: "completed" })).toHaveLength(0);
    expect((await listAudits({ limit: 1 })).length).toBeLessThanOrEqual(1);
    expect(await listAudits({ businessId: randomUUID() })).toEqual([]);
  });

  it("expireAudits lapses tier 3 to 2 and recomputes trust; another valid audit keeps tier 3", async () => {
    const b = await biz();
    const a = await requestAudit(b, "SGS", staff());
    await recordAuditResult(a.id, { result: "pass", findings: {}, validUntil: future(1) }, staff());
    expect(await expireAudits(new Date())).toBe(0);
    const later = new Date(Date.now() + 3 * day);
    expect(await expireAudits(later)).toBeGreaterThanOrEqual(1);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b } })).verificationTier).toBe(2);
    expect((await prisma.verificationAudit.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("expired");
    expect(await prisma.domainEvent.count({ where: { aggregateId: b, type: "BusinessVerified" } })).toBe(2);
    expect(await expireAudits(later)).toBe(0);

    const b2 = await biz();
    const x = await requestAudit(b2, "SGS", staff());
    await recordAuditResult(x.id, { result: "pass", findings: {}, validUntil: future(1) }, staff());
    // a second, longer-lived pass exists (inserted directly): tier stays 3
    await prisma.verificationAudit.create({ data: { businessId: b2, partner: "TUV", status: "completed", result: "pass", validUntil: future(400) } });
    await expireAudits(later);
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b2 } })).verificationTier).toBe(3);

    // business already below tier 3 (e.g. revoked): audit just expires
    const b3 = await biz();
    await prisma.verificationAudit.create({ data: { businessId: b3, partner: "SGS", status: "completed", result: "pass", validUntil: new Date(Date.now() - day) } });
    await expireAudits();
    expect((await prisma.business.findUniqueOrThrow({ where: { id: b3 } })).verificationTier).toBe(2);
  });

  it("registers a daily expiry job", async () => {
    expect(auditWorkerJobs.map((j) => j.name)).toEqual(["identity.audit-expiry"]);
    await auditWorkerJobs[0]!.run();
  });
});
