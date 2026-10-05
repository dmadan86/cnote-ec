// Buyer team: roles, invitations (single-use token, expiry, address match), role changes, removal and owner transfer with step-up.
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import {
  acceptInvite, can, changeMemberRole, effectiveRole, erasePerson, exportPersonalData, getMemberRole, getTeam, inviteMember, listMembersWithCapability, previewInvite, purgeOldInvites,
  removeMember, requireCapability, revokeInvite, transferOwnership,
} from "../src";
import { hashPassword } from "../src/password";

const PASSWORD = "Str0ng-Passw0rd-for-tests!";
const email = () => `team-${randomUUID()}@example.test`;
async function person(e = email()) {
  const p = await prisma.person.create({ data: { email: e, name: "T", passwordHash: await hashPassword(PASSWORD) }, select: { id: true, email: true } });
  return { id: p.id, email: p.email! };
}
async function company(...roles: string[]) {
  const business = await prisma.business.create({ data: { name: `Team ${randomUUID().slice(0, 6)}` } });
  const members = [];
  for (const role of roles) {
    const p = await person();
    await prisma.businessMember.create({ data: { businessId: business.id, personId: p.id, role: role as "owner" } });
    members.push(p);
  }
  return { businessId: business.id, members };
}
const events = async (type: string, businessId: string) => (await prisma.domainEvent.findMany({ where: { type }, orderBy: { id: "asc" } })).map((e) => e.payload as Record<string, unknown>).filter((p) => p.businessId === businessId);

describe("roles and capabilities", () => {
  it("maps legacy staff to requester and grants capabilities by role", () => {
    expect(effectiveRole("staff")).toBe("requester");
    expect(effectiveRole("nonsense")).toBe("viewer");
    expect(can("staff", "rfq.create")).toBe(true);
    expect(can("viewer", "rfq.create")).toBe(false);
    expect(can("approver", "approvals.decide")).toBe(true);
    expect(can("requester", "approvals.decide")).toBe(false);
    expect(can("finance", "spend.manage")).toBe(true);
    expect(can("admin", "team.manage")).toBe(true);
    expect(can("finance", "team.manage")).toBe(false);
  });

  it("reads a member's role and enforces capabilities", async () => {
    const c = await company("owner", "staff", "viewer");
    const [owner, staff, viewer] = c.members as unknown as [{ id: string }, { id: string }, { id: string }];
    expect(await getMemberRole(owner.id, c.businessId)).toBe("owner");
    expect(await getMemberRole(staff.id, c.businessId)).toBe("requester");
    expect(await getMemberRole(randomUUID(), c.businessId)).toBeNull();
    expect(await getMemberRole("nope", c.businessId)).toBeNull();
    await expect(requireCapability(viewer.id, c.businessId, "rfq.create")).rejects.toMatchObject({ code: "forbidden" });
    expect(await requireCapability(staff.id, c.businessId, "quote.decide")).toBe("requester");
    expect((await listMembersWithCapability(c.businessId, "approvals.decide")).map((m) => m.personId)).toEqual([owner.id]);
  });
});

describe("invitations", () => {
  it("invites by email, accepts once with the matching account, and emits events without the address", async () => {
    const c = await company("owner", "requester");
    const [owner, requester] = c.members as unknown as [{ id: string }, { id: string }];
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: requester.id, email: email(), role: "viewer" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: "not-an-email", role: "viewer" })).rejects.toThrow();
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: email(), role: "owner" })).rejects.toThrow();

    const invitee = await person();
    const inv = await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: invitee.email.toUpperCase(), role: "approver" });
    expect(inv.token.length).toBeGreaterThan(30);
    const stored = await prisma.businessInvite.findUnique({ where: { id: inv.inviteId } });
    expect(stored?.tokenHash).not.toContain(inv.token); // only the hash is stored
    expect(stored?.email).toBe(invitee.email);
    expect(JSON.stringify(await events("BuyerMemberInvited", c.businessId))).not.toContain(invitee.email);

    expect(await previewInvite(inv.token)).toMatchObject({ businessName: expect.any(String), role: "approver", status: "pending" });
    expect((await previewInvite(inv.token))!.email).not.toContain(invitee.email.split("@")[0]);
    expect(await previewInvite("garbage")).toBeNull();

    const stranger = await person();
    await expect(acceptInvite(inv.token, stranger.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(acceptInvite("garbage", invitee.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await acceptInvite(inv.token, invitee.id)).toEqual({ businessId: c.businessId, role: "approver" });
    expect(await getMemberRole(invitee.id, c.businessId)).toBe("approver");
    expect(await events("BuyerMemberJoined", c.businessId)).toHaveLength(1);
    await expect(acceptInvite(inv.token, invitee.id)).rejects.toMatchObject({ code: "not_found" }); // single use
    expect((await previewInvite(inv.token))?.status).toBe("used");
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: invitee.email, role: "viewer" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("expires, can be revoked, and re-inviting replaces the old link; only owners invite admins", async () => {
    const c = await company("owner", "admin");
    const [owner, admin] = c.members as unknown as [{ id: string }, { id: string }];
    const e = email();
    const now = new Date();
    const first = await inviteMember({ businessId: c.businessId, actorPersonId: admin.id, email: e, role: "viewer" }, now);
    const second = await inviteMember({ businessId: c.businessId, actorPersonId: admin.id, email: e, role: "requester" }, now);
    expect((await previewInvite(first.token))?.status).toBe("revoked");
    expect((await previewInvite(second.token))?.status).toBe("pending");
    expect((await previewInvite(second.token, new Date(now.getTime() + 8 * 86_400_000)))?.status).toBe("expired");

    const late = await person(e);
    await expect(acceptInvite(second.token, late.id, new Date(now.getTime() + 8 * 86_400_000))).rejects.toMatchObject({ code: "conflict" });
    await expect(inviteMember({ businessId: c.businessId, actorPersonId: admin.id, email: email(), role: "admin" })).rejects.toMatchObject({ code: "forbidden" });
    const adminInvite = await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: email(), role: "admin" });
    const team = await getTeam(owner.id, c.businessId);
    expect(team!.invites.map((i) => i.id)).toContain(adminInvite.inviteId);
    await revokeInvite({ businessId: c.businessId, actorPersonId: owner.id, inviteId: adminInvite.inviteId });
    await expect(revokeInvite({ businessId: c.businessId, actorPersonId: owner.id, inviteId: adminInvite.inviteId })).rejects.toMatchObject({ code: "not_found" });
    await expect(acceptInvite(adminInvite.token, late.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("team management", () => {
  it("shows full emails to managers and masked ones to everyone else", async () => {
    const c = await company("owner", "requester", "viewer");
    const [owner, requester, viewer] = c.members as unknown as [{ id: string; email: string }, { id: string; email: string }, { id: string; email: string }];
    const asOwner = await getTeam(owner.id, c.businessId);
    expect(asOwner!.members.find((m) => m.personId === requester.id)?.email).toBe(requester.email);
    const asViewer = await getTeam(viewer.id, c.businessId);
    expect(asViewer!.members.find((m) => m.personId === requester.id)?.email).toContain("***");
    expect(asViewer!.members.find((m) => m.personId === viewer.id)?.email).toBe(viewer.email);
    expect(asViewer!.invites).toEqual([]);
    expect(await getTeam(randomUUID(), c.businessId)).toBeNull();
  });

  it("changes roles within the rules and keeps the owner safe", async () => {
    const c = await company("owner", "admin", "requester", "viewer");
    const [owner, admin, requester, viewer] = c.members as unknown as [{ id: string }, { id: string }, { id: string }, { id: string }];
    await changeMemberRole({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: requester.id, role: "finance" });
    expect(await getMemberRole(requester.id, c.businessId)).toBe("finance");
    expect(await events("BuyerMemberRoleChanged", c.businessId)).toEqual([expect.objectContaining({ from: "requester", to: "finance", personId: requester.id })]);
    await expect(changeMemberRole({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: viewer.id, role: "admin" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: owner.id, role: "viewer" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: admin.id, role: "viewer" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole({ businessId: c.businessId, actorPersonId: viewer.id, targetPersonId: requester.id, role: "viewer" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(changeMemberRole({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: viewer.id, role: "owner" })).rejects.toThrow();
    await changeMemberRole({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: viewer.id, role: "admin" });
    expect(await getMemberRole(viewer.id, c.businessId)).toBe("admin");
    await expect(changeMemberRole({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: randomUUID(), role: "viewer" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("migrates a legacy staff role on first explicit assignment", async () => {
    const c = await company("owner", "staff");
    const [owner, staff] = c.members as unknown as [{ id: string }, { id: string }];
    await changeMemberRole({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: staff.id, role: "requester" });
    expect((await prisma.businessMember.findFirst({ where: { personId: staff.id } }))?.role).toBe("requester");
  });

  it("removes members, lets non-owners leave, and never removes the owner", async () => {
    const c = await company("owner", "admin", "requester", "viewer");
    const [owner, admin, requester, viewer] = c.members as unknown as [{ id: string }, { id: string }, { id: string }, { id: string }];
    await expect(removeMember({ businessId: c.businessId, actorPersonId: requester.id, targetPersonId: viewer.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeMember({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: owner.id })).rejects.toMatchObject({ code: "forbidden" });
    await expect(removeMember({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: owner.id })).rejects.toMatchObject({ code: "forbidden" });
    await removeMember({ businessId: c.businessId, actorPersonId: admin.id, targetPersonId: viewer.id });
    await removeMember({ businessId: c.businessId, actorPersonId: requester.id, targetPersonId: requester.id }); // leave
    expect(await getMemberRole(viewer.id, c.businessId)).toBeNull();
    expect(await getMemberRole(requester.id, c.businessId)).toBeNull();
    expect(await events("BuyerMemberRemoved", c.businessId)).toHaveLength(2);
    await expect(removeMember({ businessId: c.businessId, actorPersonId: owner.id, targetPersonId: viewer.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("transfers ownership only with step-up; the old owner becomes admin", async () => {
    const c = await company("owner", "admin", "viewer");
    const [owner, admin, viewer] = c.members as unknown as [{ id: string }, { id: string }, { id: string }];
    await expect(transferOwnership({ businessId: c.businessId, actorPersonId: admin.id, newOwnerPersonId: viewer.id, proof: { password: PASSWORD } })).rejects.toMatchObject({ code: "forbidden" });
    await expect(transferOwnership({ businessId: c.businessId, actorPersonId: owner.id, newOwnerPersonId: owner.id, proof: { password: PASSWORD } })).rejects.toMatchObject({ code: "validation" });
    await expect(transferOwnership({ businessId: c.businessId, actorPersonId: owner.id, newOwnerPersonId: randomUUID(), proof: { password: PASSWORD } })).rejects.toMatchObject({ code: "not_found" });
    await expect(transferOwnership({ businessId: c.businessId, actorPersonId: owner.id, newOwnerPersonId: admin.id, proof: {} })).rejects.toMatchObject({ code: "forbidden" });
    await expect(transferOwnership({ businessId: c.businessId, actorPersonId: owner.id, newOwnerPersonId: admin.id, proof: { password: "wrong-password-123" } })).rejects.toMatchObject({ code: "forbidden" });
    expect(await getMemberRole(owner.id, c.businessId)).toBe("owner");

    await transferOwnership({ businessId: c.businessId, actorPersonId: owner.id, newOwnerPersonId: admin.id, proof: { password: PASSWORD } });
    expect(await getMemberRole(admin.id, c.businessId)).toBe("owner");
    expect(await getMemberRole(owner.id, c.businessId)).toBe("admin");
    expect(await events("BusinessOwnershipTransferred", c.businessId)).toEqual([expect.objectContaining({ fromPersonId: owner.id, toPersonId: admin.id })]);
  });
});

describe("DPDP", () => {
  it("exports invitations, erases them with the person, and purges old ones", async () => {
    const c = await company("owner");
    const [owner] = c.members as unknown as [{ id: string }];
    const invitee = await person();
    const inv = await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: invitee.email, role: "viewer" });
    const exportedOwner = (await exportPersonalData(owner.id)) as { team: { invitationsSent: { email: string }[] } };
    expect(exportedOwner.team.invitationsSent.map((i) => i.email)).toContain(invitee.email);
    const exportedInvitee = (await exportPersonalData(invitee.id)) as { team: { invitationsReceived: { email: string }[] } };
    expect(exportedInvitee.team.invitationsReceived.map((i) => i.email)).toContain(invitee.email);

    await erasePerson(invitee.id);
    expect(await prisma.businessInvite.findUnique({ where: { id: inv.inviteId } })).toBeNull();

    const old = await inviteMember({ businessId: c.businessId, actorPersonId: owner.id, email: email(), role: "viewer" }, new Date(Date.now() - 60 * 86_400_000));
    expect(await purgeOldInvites(new Date(Date.now() - 30 * 86_400_000), { dryRun: true })).toBeGreaterThanOrEqual(1);
    await purgeOldInvites(new Date(Date.now() - 30 * 86_400_000));
    expect(await prisma.businessInvite.findUnique({ where: { id: old.inviteId } })).toBeNull();
  });
});
