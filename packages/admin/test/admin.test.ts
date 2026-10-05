import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AdminContext, PRIVILEGES, ROLES, ROLE_PRIVILEGES, applyStaffChange, audited, deactivateStaff, getStaff, grantStaff, hasPrivilege, listAuditLog,
  listStaff, privilegesFor, requirePrivilege, updateStaffRoles,
} from "../src";

describe("rbac matrix", () => {
  it("super_admin has every privilege", () => {
    expect([...privilegesFor(["super_admin"])].sort()).toEqual([...PRIVILEGES].sort());
  });
  it("only super_admin manages staff", () => {
    for (const r of ROLES) expect(ROLE_PRIVILEGES[r].includes("staff.manage")).toBe(r === "super_admin");
  });
  it("viewer is read-only", () => {
    for (const p of ROLE_PRIVILEGES.viewer) expect(p.endsWith(".read")).toBe(true);
  });
  it("the cookie-consent log (person ids, CSV export) is for the compliance role and super_admin only", () => {
    for (const r of ROLES) expect(ROLE_PRIVILEGES[r].includes("compliance.consent"), r).toBe(r === "super_admin" || r === "ops_moderator");
  });
  it("the ops-labels training export is super_admin only", () => {
    for (const r of ROLES) expect(ROLE_PRIVILEGES[r].includes("ai.labels.export"), r).toBe(r === "super_admin");
  });
  it("only ops_moderator/super_admin can resolve reviews and moderate", () => {
    for (const r of ROLES) {
      const ok = r === "super_admin" || r === "ops_moderator";
      expect(ROLE_PRIVILEGES[r].includes("reviews.resolve")).toBe(ok);
      expect(ROLE_PRIVILEGES[r].includes("listings.moderate")).toBe(ok);
    }
  });
  it("ugc: only ops_moderator/super_admin moderate; support and viewer read", () => {
    for (const r of ROLES) {
      expect(ROLE_PRIVILEGES[r].includes("ugc.moderate")).toBe(r === "super_admin" || r === "ops_moderator");
      expect(ROLE_PRIVILEGES[r].includes("ugc.read")).toBe(["super_admin", "ops_moderator", "support", "viewer"].includes(r));
    }
  });
  it("verification_officer verifies but cannot see billing or audit", () => {
    const p = privilegesFor(["verification_officer"]);
    expect(p.has("businesses.verify")).toBe(true);
    expect(p.has("billing.read")).toBe(false);
    expect(p.has("audit.read")).toBe(false);
  });
  it("unknown roles grant nothing; roles union", () => {
    expect(privilegesFor(["nope"]).size).toBe(0);
    expect(privilegesFor(["support", "finance"]).has("billing.adjust")).toBe(true);
  });
  it("requirePrivilege throws forbidden", () => {
    const staff = { privileges: ["reviews.read" as const] };
    expect(hasPrivilege(staff, "reviews.read")).toBe(true);
    expect(() => requirePrivilege(staff, "reviews.resolve")).toThrow(DomainError);
  });
});

describe("staff + audit (db)", () => {
  const tag = `admintest-${randomUUID().slice(0, 8)}`;
  const personIds: string[] = [];
  const mkPerson = async () => {
    const p = await prisma.person.create({ data: { email: `${tag}-${randomUUID().slice(0, 6)}@example.test` } });
    personIds.push(p.id);
    return p.id;
  };
  const ctxFor = async (personId: string): Promise<AdminContext> => ({ staff: (await getStaff(personId))!, ip: "127.0.0.1", userAgent: tag });
  let superA: string, superB: string;

  beforeAll(async () => {
    superA = await mkPerson();
    superB = await mkPerson();
    for (const id of [superA, superB]) await prisma.staffMember.create({ data: { personId: id, roles: ["super_admin"] } });
  });
  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { OR: [{ userAgent: tag }, { subjectId: { in: personIds } }] } });
    await prisma.staffMember.deleteMany({ where: { personId: { in: personIds } } });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  });

  it("getStaff returns null for inactive / unknown and touches lastSeenAt", async () => {
    expect(await getStaff(randomUUID())).toBeNull();
    expect(await getStaff("not-a-uuid")).toBeNull();
    const s = await getStaff(superA);
    expect(s?.privileges.length).toBe(PRIVILEGES.length);
    const row = await prisma.staffMember.findUnique({ where: { personId: superA } });
    expect(row?.lastSeenAt).not.toBeNull();
  });

  it("audited writes on success and on failure, and denies without privilege", async () => {
    const actor = await mkPerson();
    await grantStaff(await ctxFor(superA), actor, ["viewer"]);
    const viewer = await ctxFor(actor);
    const subjectId = `s-${tag}`;
    const out = await audited(await ctxFor(superA), "reviews.read", "test.ok", { type: "t", id: subjectId }, async () => 42, { a: 1 });
    expect(out).toBe(42);
    await expect(
      audited(await ctxFor(superA), "reviews.read", "test.fail", { type: "t", id: subjectId }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(audited(viewer, "reviews.resolve", "test.denied", { type: "t", id: subjectId }, async () => 1)).rejects.toThrow(DomainError);
    const rows = await prisma.adminAuditLog.findMany({ where: { subjectId }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.action).sort()).toEqual(["test.denied", "test.fail", "test.ok"]);
    expect((rows.find((r) => r.action === "test.fail")!.details as { error: string }).error).toBe("boom");
    expect((rows.find((r) => r.action === "test.denied")!.details as { denied: boolean }).denied).toBe(true);
    expect(rows.find((r) => r.action === "test.ok")!.staffId).toBeTruthy();
  });

  it("staff.manage is required to grant", async () => {
    const viewerPerson = await mkPerson();
    await grantStaff(await ctxFor(superA), viewerPerson, ["viewer"]);
    await expect(grantStaff(await ctxFor(viewerPerson), await mkPerson(), ["viewer"])).rejects.toMatchObject({ code: "forbidden" });
    await expect(listStaff(await ctxFor(viewerPerson))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("cannot remove own super_admin, nor the last one", async () => {
    await expect(updateStaffRoles(await ctxFor(superA), superA, ["viewer"])).rejects.toMatchObject({ code: "conflict" });
    await expect(deactivateStaff(await ctxFor(superA), superA)).rejects.toMatchObject({ code: "conflict" });
    // demote B via A works (another super_admin remains: A)
    await updateStaffRoles(await ctxFor(superA), superB, ["support"]);
    expect((await getStaff(superB))?.roles).toEqual(["support"]);
    // last-super_admin guard: only deterministic when no real super_admin exists in the dev DB
    const outsiders = await prisma.staffMember.count({ where: { active: true, roles: { has: "super_admin" }, personId: { notIn: personIds } } });
    if (outsiders === 0) {
      await updateStaffRoles(await ctxFor(superA), superB, ["support"]);
      await expect(applyStaffChange({ personId: superA }, { active: false })).rejects.toMatchObject({ code: "conflict" });
    }
    await updateStaffRoles(await ctxFor(superA), superB, ["super_admin"]);
  });

  it("deactivated staff lose access; audit log is filterable + paginated", async () => {
    const p = await mkPerson();
    await grantStaff(await ctxFor(superA), p, ["support"]);
    await deactivateStaff(await ctxFor(superA), p);
    expect(await getStaff(p)).toBeNull();
    const page1 = await listAuditLog(await ctxFor(superA), { subjectId: p, limit: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listAuditLog(await ctxFor(superA), { subjectId: p, limit: 1, cursor: page1.nextCursor! });
    expect(page2.items[0]!.id).not.toBe(page1.items[0]!.id);
    const noPriv = await ctxFor(superA);
    await expect(listAuditLog({ staff: { ...noPriv.staff, privileges: [] } }, {})).rejects.toMatchObject({ code: "forbidden" });
  });
});
