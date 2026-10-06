// Buyer team: sparse/erased data, limits, races and the remaining permission edges.
import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import {
  acceptInvite, changeMemberRole, getMemberRole, getTeam, inviteMember, MAX_PENDING_INVITES, MAX_TEAM_SIZE, previewInvite, removeMember, revokeInvite,
} from "../src";
import { hashPassword } from "../src/password";
import { sha256 } from "../src/tokens";

const email = () => `teamx-${randomUUID()}@example.test`;
async function person(o: { email?: string | null; name?: string | null; erasedAt?: Date } = {}) {
  const p = await prisma.person.create({
    data: { email: o.email === undefined ? email() : o.email, name: o.name === undefined ? "T" : o.name, passwordHash: await hashPassword("Str0ng-Passw0rd-for-tests!"), erasedAt: o.erasedAt },
    select: { id: true, email: true },
  });
  return { id: p.id, email: p.email };
}
async function company(...roles: string[]) {
  const business = await prisma.business.create({ data: { name: `TeamX ${randomUUID().slice(0, 6)}` } });
  const members = [];
  for (const role of roles) {
    const p = await person();
    await prisma.businessMember.create({ data: { businessId: business.id, personId: p.id, role: role as "owner" } });
    members.push({ id: p.id, email: p.email! });
  }
  return { businessId: business.id, members };
}

describe("getTeam views", () => {
  it("is null for non-members; masks emails for non-managers, blanks erased people, marks expired invites", async () => {
    const c = await company("owner", "viewer");
    const [owner, viewer] = c.members as unknown as [{ id: string }, { id: string }];
    expect(await getTeam(randomUUID(), c.businessId)).toBeNull();

    const noMail = await person({ email: null, name: null });
    await prisma.businessMember.create({ data: { businessId: c.businessId, personId: noMail.id, role: "requester" } });
    const weird = await person({ email: `x${randomUUID().slice(0, 6)}@example.test` });
    await prisma.businessMember.create({ data: { businessId: c.businessId, personId: weird.id, role: "approver" } });
    const gone = await person({ erasedAt: new Date() });
    await prisma.businessMember.create({ data: { businessId: c.businessId, personId: gone.id, role: "finance" } });

    const asViewer = (await getTeam(viewer.id, c.businessId))!;
    expect(asViewer.myRole).toBe("viewer");
    expect(asViewer.invites).toEqual([]);
    const byId = (id: string) => asViewer.members.find((m) => m.personId === id)!;
    expect(byId(noMail.id).email).toBeNull();
    expect(byId(weird.id).email).toMatch(/^.\*\*\*@example\.test$/);
    expect(byId(gone.id)).toMatchObject({ email: null, name: null });
    expect(byId(viewer.id).email).toContain("@"); // own address is shown in full
    expect(byId(viewer.id).email).not.toContain("***");
    expect(asViewer.members[0]!.role).toBe("owner"); // sorted by role order

    const past = new Date(Date.now() - 20 * 86_400_000);
    await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: email(), role: "viewer" }, past);
    const fresh = await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: email(), role: "viewer" });
    const asOwner = (await getTeam(owner.id, c.businessId))!;
    expect(asOwner.invites.map((i) => i.status).sort()).toEqual(["expired", "pending"]);
    expect(asOwner.invites.find((i) => i.id === fresh.inviteId)?.status).toBe("pending");
    expect(byIdEmail(asOwner, noMail.id)).toBeNull();
  });
});
const byIdEmail = (t: { members: { personId: string; email: string | null }[] }, id: string) => t.members.find((m) => m.personId === id)!.email;

describe("invite limits", () => {
  it("refuses a team at its size limit and too many pending invitations", async () => {
    const c = await company("owner");
    const owner = c.members[0]!;
    await redis.del(`team:invite:${c.businessId}`);
    const people = Array.from({ length: MAX_TEAM_SIZE - 1 }, () => ({ id: randomUUID(), email: email() }));
    await prisma.person.createMany({ data: people });
    await prisma.businessMember.createMany({ data: people.map((p) => ({ businessId: c.businessId, personId: p.id, role: "viewer" as const })) });
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: email(), role: "viewer" })).rejects.toThrow(/size limit/);

    const d = await company("owner");
    await prisma.businessInvite.createMany({
      data: Array.from({ length: MAX_PENDING_INVITES }, () => ({
        businessId: d.businessId, email: email(), role: "viewer" as const, tokenHash: sha256(randomUUID()), invitedByPersonId: d.members[0]!.id, expiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
    await expect(inviteMember({ businessId: d.businessId, actorPersonId: d.members[0]!.id, email: email(), role: "viewer" })).rejects.toThrow(/Too many pending/);
  });
  it("refuses inviting someone who is already on the team, and admin invites by non-owners", async () => {
    const c = await company("owner", "admin", "viewer");
    const [owner, admin, viewer] = c.members as unknown as [{ id: string; email: string }, { id: string }, { id: string; email: string }];
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: viewer.email.toUpperCase(), role: "viewer" })).rejects.toMatchObject({ code: "conflict" });
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: admin.id, email: email(), role: "admin" })).rejects.toMatchObject({ code: "forbidden" });
    // an existing account that is not yet on the team can be invited
    const outsider = await person();
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: outsider.email!, role: "approver" })).resolves.toMatchObject({ role: "approver" });
  });
});

describe("revoke and preview", () => {
  it("revoke validates the id, only affects open invitations, and preview reports every state", async () => {
    const c = await company("owner");
    const owner = c.members[0]!;
    await expect(revokeInvite({ businessId: c.businessId, actorPersonId: owner.id, inviteId: "nope" })).rejects.toMatchObject({ code: "not_found" });
    await expect(revokeInvite({ businessId: c.businessId, actorPersonId: owner.id, inviteId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });

    const a = await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: "ab@example.test", role: "viewer" });
    expect(await previewInvite(a.token)).toMatchObject({ status: "pending", role: "viewer", email: "a***@example.test" });
    expect((await previewInvite(a.token, new Date(Date.now() + 30 * 86_400_000)))?.status).toBe("expired");
    await revokeInvite({ businessId: c.businessId, actorPersonId: owner.id, inviteId: a.inviteId });
    expect((await previewInvite(a.token))?.status).toBe("revoked");
    await expect(revokeInvite({ businessId: c.businessId, actorPersonId: owner.id, inviteId: a.inviteId })).rejects.toMatchObject({ code: "not_found" });

    const invitee = await person();
    const b = await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: invitee.email!, role: "viewer" });
    await acceptInvite(b.token, invitee.id);
    expect((await previewInvite(b.token))?.status).toBe("used");

    expect(await previewInvite("")).toBeNull();
    expect(await previewInvite("x".repeat(201))).toBeNull();
    expect(await previewInvite("unknown-token")).toBeNull();
  });
  it("masks degenerate addresses completely", async () => {
    const c = await company("owner");
    const token = randomUUID();
    await prisma.businessInvite.create({ data: { businessId: c.businessId, email: "@nolocal.test", role: "viewer", tokenHash: sha256(token), invitedByPersonId: c.members[0]!.id, expiresAt: new Date(Date.now() + 86_400_000) } });
    expect((await previewInvite(token))?.email).toBe("***");
  });
});

describe("acceptInvite edges", () => {
  async function invited() {
    const c = await company("owner");
    const invitee = await person();
    await redis.del(`team:accept:${invitee.id}`);
    const inv = await inviteMember({ businessId: c.businessId, actorPersonId: c.members[0]!.id, email: invitee.email!, role: "approver" });
    return { c, invitee, inv };
  }
  it("rejects empty/oversized/unknown/revoked/used tokens and expired invites", async () => {
    const { c, invitee, inv } = await invited();
    await expect(acceptInvite("", invitee.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptInvite("x".repeat(201), invitee.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptInvite("unknown", invitee.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptInvite(inv.token, invitee.id, new Date(Date.now() + 30 * 86_400_000))).rejects.toMatchObject({ code: "conflict" });
    await revokeInvite({ businessId: c.businessId, actorPersonId: c.members[0]!.id, inviteId: inv.inviteId });
    await expect(acceptInvite(inv.token, invitee.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("requires the invited address on a live account", async () => {
    const { inv } = await invited();
    const other = await person();
    await expect(acceptInvite(inv.token, other.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(acceptInvite(inv.token, randomUUID())).rejects.toMatchObject({ code: "forbidden" });
    const noMail = await person({ email: null });
    await expect(acceptInvite(inv.token, noMail.id)).rejects.toMatchObject({ code: "forbidden" });
  });
  it("an already-present member keeps their role (never downgrades) and the invite is consumed", async () => {
    const { c, invitee, inv } = await invited();
    await prisma.businessMember.create({ data: { businessId: c.businessId, personId: invitee.id, role: "admin" } });
    await expect(acceptInvite(inv.token, invitee.id)).resolves.toMatchObject({ businessId: c.businessId, role: "approver" });
    expect(await getMemberRole(invitee.id, c.businessId)).toBe("admin");
    await expect(acceptInvite(inv.token, invitee.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it("two concurrent accepts: exactly one wins", async () => {
    const { invitee, inv } = await invited();
    const results = await Promise.allSettled([acceptInvite(inv.token, invitee.id), acceptInvite(inv.token, invitee.id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "not_found" });
  });
});

describe("changeMemberRole / removeMember edges", () => {
  it("is a no-op for the same role (no event) but migrates legacy staff; owners may demote themselves out of the rule", async () => {
    const c = await company("owner", "admin", "requester");
    const [owner, admin, requester] = c.members as unknown as [{ id: string }, { id: string }, { id: string }];
    await changeMemberRole({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: requester.id, role: "requester" });
    expect(await prisma.domainEvent.count({ where: { type: "BuyerMemberRoleChanged", aggregateId: c.businessId } })).toBe(0);
    // an admin target can only be changed by the owner
    await expect(changeMemberRole({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: admin.id, role: "viewer" })).rejects.toMatchObject({ code: "forbidden" });
    await changeMemberRole({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: admin.id, role: "viewer" });
    expect(await getMemberRole(admin.id, c.businessId)).toBe("viewer");
  });
  it("removal: a non-member cannot leave, a lone admin cannot be removed by another admin, an admin may leave", async () => {
    const c = await company("owner", "admin", "admin");
    const [owner, adminA, adminB] = c.members as unknown as [{ id: string }, { id: string }, { id: string }];
    const stranger = randomUUID();
    await expect(removeMember({ businessId: c.businessId, actorPersonId: stranger, targetPersonId: stranger })).rejects.toMatchObject({ code: "not_found" });
    await expect(removeMember({ businessId: c.businessId, actorPersonId: adminA.id, targetPersonId: adminB.id })).rejects.toMatchObject({ code: "forbidden" });
    await removeMember({ businessId: c.businessId, actorPersonId: adminA.id, targetPersonId: adminA.id });
    await removeMember({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: adminB.id });
    expect(await getMemberRole(adminA.id, c.businessId)).toBeNull();
    expect(await getMemberRole(adminB.id, c.businessId)).toBeNull();
  });
});
