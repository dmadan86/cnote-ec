import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { applyStaffChange, getStaff } from "../src";
import { staffRolesByPerson } from "../src/staff";

const tag = `staffcov-${randomUUID().slice(0, 8)}`;
const personIds: string[] = [];
const mkPerson = async () => {
  const p = await prisma.person.create({ data: { email: `${tag}-${randomUUID().slice(0, 6)}@example.test` } });
  personIds.push(p.id);
  return p.id;
};

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await prisma.staffMember.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("staffRolesByPerson", () => {
  it("returns an empty map without querying when no ids are valid uuids", async () => {
    const spy = vi.spyOn(prisma.staffMember, "findMany");
    expect((await staffRolesByPerson([])).size).toBe(0);
    expect((await staffRolesByPerson(["not-a-uuid", ""])).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
  it("maps known staff to role codes, drops unknown role codes, and omits non-staff", async () => {
    const a = await mkPerson();
    const b = await mkPerson();
    const c = await mkPerson();
    await prisma.staffMember.create({ data: { personId: a, roles: ["viewer", "legacy_role_x"] } });
    await prisma.staffMember.create({ data: { personId: b, roles: ["support"], active: false } });
    const map = await staffRolesByPerson([a, b, c, "junk"]);
    expect(map.get(a)).toEqual(["viewer"]);
    expect(map.get(b)).toEqual(["support"]); // deactivated members are still attributable
    expect(map.has(c)).toBe(false);
    expect(map.size).toBe(2);
  });
});

describe("getStaff heartbeat", () => {
  it("never fails the request when the lastSeenAt update errors", async () => {
    const p = await mkPerson();
    await prisma.staffMember.create({ data: { personId: p, roles: ["viewer"] } });
    vi.spyOn(prisma.staffMember, "update").mockRejectedValue(new Error("db down"));
    const view = await getStaff(p);
    expect(view?.roles).toEqual(["viewer"]);
    expect(view?.lastSeenAt).not.toBeNull();
  });
  it("returns null for non-uuid ids, unknown people and deactivated members", async () => {
    expect(await getStaff("nope")).toBeNull();
    expect(await getStaff(randomUUID())).toBeNull();
    const p = await mkPerson();
    await prisma.staffMember.create({ data: { personId: p, roles: ["viewer"], active: false } });
    expect(await getStaff(p)).toBeNull();
  });
});

describe("applyStaffChange error mapping", () => {
  const failWith = (err: unknown) => vi.spyOn(prisma, "$transaction").mockRejectedValue(err);
  it("maps FK violation to not_found, serialization failure to conflict, and rethrows others", async () => {
    failWith(Object.assign(new Error("fk"), { code: "P2003" }));
    await expect(applyStaffChange({ personId: randomUUID() }, { roles: ["viewer"], upsert: true })).rejects.toMatchObject({ code: "not_found" });
    vi.restoreAllMocks();
    failWith(Object.assign(new Error("ser"), { code: "P2034" }));
    await expect(applyStaffChange({ personId: randomUUID() }, { active: false })).rejects.toMatchObject({ code: "conflict" });
    vi.restoreAllMocks();
    const boom = new Error("boom");
    failWith(boom);
    await expect(applyStaffChange({ personId: randomUUID() }, { active: false })).rejects.toBe(boom);
  });
  it("blocks removing your own super_admin even when another super_admin exists", async () => {
    const me = await mkPerson();
    const other = await mkPerson();
    await prisma.staffMember.createMany({ data: [{ personId: me, roles: ["super_admin"] }, { personId: other, roles: ["super_admin"] }] });
    await expect(applyStaffChange({ personId: me }, { roles: ["viewer"] }, { actorPersonId: me })).rejects.toMatchObject({ code: "conflict" });
    const res = await applyStaffChange({ personId: me }, { roles: ["viewer"] }, { actorPersonId: other });
    expect(res.before?.roles).toEqual(["super_admin"]);
    expect(res.after).toEqual({ roles: ["viewer"], active: true });
  });
});
