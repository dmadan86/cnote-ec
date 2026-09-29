import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type AdminContext, applyStaffChange, audited, getStaff, grantStaff, listAuditLog, listStaff, updateStaffRoles } from "../src";
import { writeAudit } from "../src/audit";

const tag = `adminmore-${randomUUID().slice(0, 8)}`;
const personIds: string[] = [];
const mkPerson = async (email = true) => {
  const p = await prisma.person.create({ data: { email: email ? `${tag}-${randomUUID().slice(0, 6)}@example.test` : null } });
  personIds.push(p.id);
  return p.id;
};
const ctxFor = async (personId: string): Promise<AdminContext> => ({ staff: (await getStaff(personId))!, ip: "10.0.0.1", userAgent: tag });

let superA: string;
beforeAll(async () => {
  superA = await mkPerson();
  await prisma.staffMember.create({ data: { personId: superA, roles: ["super_admin"] } });
});
afterEach(() => vi.restoreAllMocks());
function cyclic() {
  const o: Record<string, unknown> = {};
  o.self = o;
  return o;
}
afterAll(async () => {
  await prisma.adminAuditLog.deleteMany({ where: { OR: [{ userAgent: tag }, { subjectId: { in: personIds } }, { subjectType: tag }] } });
  await prisma.staffMember.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("writeAudit", () => {
  it("clips long text to 500 chars and JSON-normalises details", async () => {
    const subjectId = `${tag}-${"x".repeat(900)}`;
    await writeAudit({ staffId: null, privilege: "p", action: "clip", subject: { type: tag, id: subjectId }, details: { a: undefined, b: 1 }, ip: "i".repeat(600), userAgent: tag });
    const row = await prisma.adminAuditLog.findFirst({ where: { subjectType: tag, action: "clip" } });
    expect(row!.subjectId).toHaveLength(500);
    expect(row!.ip).toHaveLength(500);
    expect(row!.details).toEqual({ b: 1 });
    expect(row!.staffId).toBeNull();
  });
  it("rejects circular details", async () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    await expect(writeAudit({ staffId: null, privilege: "p", action: "cyc", details: a })).rejects.toThrow();
  });
  it("stores null subject fields when no subject", async () => {
    await writeAudit({ staffId: null, privilege: "p", action: `nosubj-${tag}`, userAgent: tag });
    const row = await prisma.adminAuditLog.findFirst({ where: { action: `nosubj-${tag}` } });
    expect(row).toMatchObject({ subjectType: null, subjectId: null, ip: null, details: {} });
  });
});

describe("audited", () => {
  it("records DomainError code on failure and ip/userAgent from ctx", async () => {
    const { DomainError } = await import("@cnote/core");
    const subjectId = `s-${randomUUID()}`;
    await expect(
      audited(await ctxFor(superA), "reviews.read", "t.domain", { type: "t", id: subjectId }, async () => {
        throw new DomainError("conflict", "nope");
      }, { extra: true }),
    ).rejects.toMatchObject({ code: "conflict" });
    const row = await prisma.adminAuditLog.findFirst({ where: { subjectId } });
    expect(row!.details).toMatchObject({ extra: true, error: "nope", errorCode: "conflict" });
    expect(row).toMatchObject({ ip: "10.0.0.1", userAgent: tag });
  });
  it("stringifies non-Error throws and truncates the message", async () => {
    const subjectId = `s-${randomUUID()}`;
    await expect(
      audited(await ctxFor(superA), "reviews.read", "t.str", { type: "t", id: subjectId }, async () => {
        throw "y".repeat(2000);
      }),
    ).rejects.toBe("y".repeat(2000));
    const row = await prisma.adminAuditLog.findFirst({ where: { subjectId } });
    expect((row!.details as { error: string }).error).toHaveLength(500);
  });
  it("never runs fn when denied, and still throws forbidden even if the audit write fails", async () => {
    const fn = vi.fn(async () => 1);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = { staff: { ...(await ctxFor(superA)).staff, privileges: [] } };
    await expect(audited(ctx, "reviews.read", "t.denied2", { type: "t", id: "x" }, fn, cyclic())).rejects.toMatchObject({ code: "forbidden" });
    expect(fn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalled();
  });
  it("propagates the audit error when the success audit write fails (fn already ran)", async () => {
    const fn = vi.fn(async () => "done");
    const ctx = await ctxFor(superA);
    await expect(audited(ctx, "reviews.read", "t.succ", { type: "t", id: "x" }, fn, cyclic())).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledOnce();
  });
  it("swallows a failing failure-audit write and rethrows the original error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ctx = await ctxFor(superA);
    await expect(
      audited(ctx, "reviews.read", "t.f", { type: "t", id: "x" }, async () => {
        throw new Error("orig");
      }, cyclic()),
    ).rejects.toThrow("orig");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("listAuditLog filters", () => {
  it("supports exact/prefix action, privilege, subject, staffId, date range and validates limit", async () => {
    const ctx = await ctxFor(superA);
    const sid = `f-${randomUUID()}`;
    for (const a of ["zz.one", "zz.two", "yy.three"]) await audited(ctx, "reviews.read", `${tag}.${a}`, { type: "t", id: sid }, async () => 0);
    const all = await listAuditLog(ctx, { subjectId: sid });
    expect(all.items).toHaveLength(3);
    expect(all.nextCursor).toBeNull();
    expect(all.items[0]!.createdAt >= all.items[2]!.createdAt).toBe(true);
    expect((await listAuditLog(ctx, { subjectId: sid, action: `${tag}.zz.*` })).items).toHaveLength(2);
    expect((await listAuditLog(ctx, { subjectId: sid, action: `${tag}.yy.three` })).items).toHaveLength(1);
    expect((await listAuditLog(ctx, { subjectId: sid, privilege: "nope" })).items).toHaveLength(0);
    expect((await listAuditLog(ctx, { subjectId: sid, subjectType: "t", staffId: ctx.staff.id })).items).toHaveLength(3);
    expect((await listAuditLog(ctx, { subjectId: sid, from: new Date(Date.now() + 60_000) })).items).toHaveLength(0);
    expect((await listAuditLog(ctx, { subjectId: sid, to: new Date(Date.now() + 60_000) })).items).toHaveLength(3);
    await expect(listAuditLog(ctx, { limit: 0 })).rejects.toThrow();
    await expect(listAuditLog(ctx, { limit: 201 })).rejects.toThrow();
    await expect(listAuditLog(ctx, { staffId: "nope" })).rejects.toThrow();
  });
});

describe("staff changes", () => {
  it("rejects invalid input before touching the DB", async () => {
    const ctx = await ctxFor(superA);
    await expect(grantStaff(ctx, "not-uuid", ["viewer"])).rejects.toThrow();
    await expect(grantStaff(ctx, randomUUID(), [])).rejects.toThrow();
    await expect(grantStaff(ctx, randomUUID(), ["root"])).rejects.toThrow();
  });
  it("de-duplicates roles; missing person -> not_found; unknown staff update -> not_found", async () => {
    const ctx = await ctxFor(superA);
    const p = await mkPerson();
    await grantStaff(ctx, p, ["support", "support", "viewer"]);
    expect((await getStaff(p))!.roles.sort()).toEqual(["support", "viewer"]);
    await expect(grantStaff(ctx, randomUUID(), ["viewer"])).rejects.toMatchObject({ code: "not_found" });
    await expect(updateStaffRoles(ctx, randomUUID(), ["viewer"])).rejects.toMatchObject({ code: "not_found" });
  });
  it("re-granting reactivates a deactivated member; before/after reported", async () => {
    const p = await mkPerson();
    const r1 = await applyStaffChange({ personId: p }, { roles: ["viewer"], upsert: true });
    expect(r1).toEqual({ before: null, after: { roles: ["viewer"], active: true } });
    const r2 = await applyStaffChange({ personId: p }, { active: false });
    expect(r2.before).toEqual({ roles: ["viewer"], active: true });
    expect(await getStaff(p)).toBeNull();
    await applyStaffChange({ personId: p }, { roles: ["support"], active: true });
    expect((await getStaff(p))!.roles).toEqual(["support"]);
  });
  it("listStaff includes deactivated members and hides unknown role codes from views", async () => {
    const p = await mkPerson();
    await prisma.staffMember.create({ data: { personId: p, roles: ["viewer", "legacy_role"], active: false, createdBy: null } });
    const rows = await listStaff(await ctxFor(superA));
    const mine = rows.find((r) => r.personId === p)!;
    expect(mine.active).toBe(false);
    expect(mine.roles).toEqual(["viewer"]);
    expect(mine.privileges).not.toContain("staff.manage");
  });
  it("getStaff only touches lastSeenAt when stale (>5min)", async () => {
    const p = await mkPerson();
    const fresh = new Date();
    await prisma.staffMember.create({ data: { personId: p, roles: ["viewer"], lastSeenAt: fresh } });
    await getStaff(p);
    expect((await prisma.staffMember.findUnique({ where: { personId: p } }))!.lastSeenAt!.getTime()).toBe(fresh.getTime());
    const stale = new Date(Date.now() - 6 * 60_000);
    await prisma.staffMember.update({ where: { personId: p }, data: { lastSeenAt: stale } });
    const view = await getStaff(p);
    expect(new Date(view!.lastSeenAt!).getTime()).toBeGreaterThan(stale.getTime());
    expect((await prisma.staffMember.findUnique({ where: { personId: p } }))!.lastSeenAt!.getTime()).toBeGreaterThan(stale.getTime());
  });

  it("concurrent mutual demotions of the only two super_admins never leave zero", async () => {
    // Isolate: this runs against a DB that may hold other super_admins; deactivate them for the duration.
    const others = await prisma.staffMember.findMany({ where: { active: true, roles: { has: "super_admin" }, personId: { notIn: personIds } }, select: { id: true } });
    await prisma.staffMember.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { active: false } });
    try {
      const a = await mkPerson();
      const b = await mkPerson();
      await prisma.staffMember.createMany({ data: [{ personId: a, roles: ["super_admin"] }, { personId: b, roles: ["super_admin"] }] });
      // make superA (from beforeAll) non-super so exactly a and b remain
      await prisma.staffMember.update({ where: { personId: superA }, data: { roles: ["viewer"] } });
      const results = await Promise.allSettled([
        applyStaffChange({ personId: a }, { active: false }),
        applyStaffChange({ personId: b }, { active: false }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      expect(ok).toBeLessThanOrEqual(1);
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      for (const r of rejected) expect(r.reason).toMatchObject({ code: "conflict" });
      const remaining = await prisma.staffMember.count({ where: { active: true, roles: { has: "super_admin" }, personId: { in: [a, b] } } });
      expect(remaining).toBeGreaterThanOrEqual(1);
      await prisma.staffMember.update({ where: { personId: superA }, data: { roles: ["super_admin"] } });
    } finally {
      await prisma.staffMember.updateMany({ where: { id: { in: others.map((o) => o.id) } }, data: { active: true } });
    }
  });
});
