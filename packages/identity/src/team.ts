// Buyer team: roles, capabilities, invitations, role changes, removal and owner transfer (docs/design/buyer-approvals.md).
// A BusinessMember row is the only membership record; the role decides what the person may do for that business.
// Invitation tokens are single use and only their sha256 is stored. The raw token is returned once so the caller can email it
// (the email body lives in a DB template, never here).
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { enforceLimit } from "./limits";
import { normaliseEmail } from "./password";
import { verifyErasureStepUp, type ErasureStepUp } from "./privacy";
import { randomToken, sha256 } from "./tokens";

/** Roles a buyer team member can hold. `staff` (legacy) is stored for old rows only and behaves as `requester`. */
export const TEAM_ROLES = ["owner", "admin", "requester", "approver", "finance", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
/** Roles an invitation may carry (ownership moves only through `transferOwnership`). */
export const INVITABLE_ROLES = ["admin", "requester", "approver", "finance", "viewer"] as const satisfies readonly TeamRole[];
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

/** Legacy `staff` is requester-equivalent. */
export function effectiveRole(stored: string): TeamRole {
  return stored === "staff" ? "requester" : (TEAM_ROLES as readonly string[]).includes(stored) ? (stored as TeamRole) : "viewer";
}

export type Capability =
  | "rfq.create"
  | "quote.decide"
  | "orders.view"
  | "team.manage"
  | "policy.manage"
  | "spend.manage"
  | "approvals.decide";

const CAPS: Record<TeamRole, readonly Capability[]> = {
  owner: ["rfq.create", "quote.decide", "orders.view", "team.manage", "policy.manage", "spend.manage", "approvals.decide"],
  admin: ["rfq.create", "quote.decide", "orders.view", "team.manage", "policy.manage", "spend.manage", "approvals.decide"],
  requester: ["rfq.create", "quote.decide", "orders.view"],
  approver: ["orders.view", "approvals.decide"],
  finance: ["orders.view", "spend.manage", "approvals.decide"],
  viewer: ["orders.view"],
};

export const can = (role: TeamRole | string, cap: Capability): boolean => CAPS[effectiveRole(role)].includes(cap);

/** The person's role in the business, or null when they are not a member. */
export async function getMemberRole(personId: string, businessId: string): Promise<TeamRole | null> {
  if (!UUID.test(personId) || !UUID.test(businessId)) return null;
  const m = await prisma.businessMember.findUnique({ where: { businessId_personId: { businessId, personId } }, select: { role: true } });
  return m ? effectiveRole(m.role) : null;
}

/** Throws `forbidden` unless the person is a member whose role grants the capability. Returns the role. */
export async function requireCapability(personId: string, businessId: string, cap: Capability): Promise<TeamRole> {
  const role = await getMemberRole(personId, businessId);
  if (!role || !can(role, cap)) throw new DomainError("forbidden", "Your role does not allow this.");
  return role;
}

const UUID = /^[0-9a-f-]{36}$/i;
export const INVITE_TTL_DAYS = 7;
export const MAX_TEAM_SIZE = 100;
export const MAX_PENDING_INVITES = 50;
const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email("Enter a valid email address."));
const roleSchema = z.enum(INVITABLE_ROLES);

export interface TeamMemberView {
  personId: string;
  name: string | null;
  /** full address for people who manage the team, masked for everyone else */
  email: string | null;
  role: TeamRole;
  /** the role as stored (`staff` for legacy rows) */
  storedRole: string;
}
export interface TeamInviteView {
  id: string;
  email: string;
  role: InvitableRole;
  expiresAt: string;
  createdAt: string;
  status: "pending" | "expired";
}
export interface TeamView {
  members: TeamMemberView[];
  invites: TeamInviteView[];
  myRole: TeamRole;
}

const mask = (email: string | null) => {
  if (!email) return null;
  const at = email.indexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
};

/** The team of a business as the actor sees it. Null when the actor is not a member. */
export async function getTeam(actorPersonId: string, businessId: string, now = new Date()): Promise<TeamView | null> {
  const myRole = await getMemberRole(actorPersonId, businessId);
  if (!myRole) return null;
  const manage = can(myRole, "team.manage");
  const rows = await prisma.businessMember.findMany({
    where: { businessId },
    include: { person: { select: { name: true, email: true, erasedAt: true } } },
    orderBy: { personId: "asc" },
  });
  const order = (r: TeamRole) => TEAM_ROLES.indexOf(r);
  const members = rows
    .map<TeamMemberView>((r) => ({
      personId: r.personId,
      name: r.person.erasedAt ? null : r.person.name,
      email: r.person.erasedAt ? null : manage || r.personId === actorPersonId ? r.person.email : mask(r.person.email),
      role: effectiveRole(r.role),
      storedRole: r.role,
    }))
    .sort((a, b) => order(a.role) - order(b.role));
  const invites = manage
    ? (await prisma.businessInvite.findMany({ where: { businessId, acceptedAt: null, revokedAt: null }, orderBy: { createdAt: "desc" }, take: MAX_PENDING_INVITES })).map<TeamInviteView>((i) => ({
        id: i.id,
        email: i.email,
        role: i.role as InvitableRole,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
        status: i.expiresAt.getTime() <= now.getTime() ? "expired" : "pending",
      }))
    : [];
  return { members, invites, myRole };
}

/** Everyone in the business who holds the capability (used to resolve approvers). */
export async function listMembersWithCapability(businessId: string, cap: Capability): Promise<{ personId: string; role: TeamRole }[]> {
  const rows = await prisma.businessMember.findMany({ where: { businessId }, select: { personId: true, role: true }, orderBy: { personId: "asc" } });
  return rows.map((r) => ({ personId: r.personId, role: effectiveRole(r.role) })).filter((r) => can(r.role, cap));
}

export interface InviteResult {
  inviteId: string;
  /** raw single-use token: shown to the caller once, to be emailed; only its hash is stored */
  token: string;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
  businessName: string;
}

/** Owner/admin invites a person by email. Only owners may invite admins. Re-inviting an address replaces its pending invite. */
export async function inviteMember(input: { businessId: string; actorPersonId: string; email: string; role: string }, now = new Date()): Promise<InviteResult> {
  const actorRole = await requireCapability(input.actorPersonId, input.businessId, "team.manage");
  const email = emailSchema.parse(input.email);
  const role = roleSchema.parse(input.role);
  if (role === "admin" && actorRole !== "owner") throw new DomainError("forbidden", "Only the owner can invite an admin.");
  await enforceLimit(`team:invite:${input.businessId}`, 30, 86_400, "Too many invitations today. Try again tomorrow.");

  const existing = await prisma.person.findUnique({ where: { email }, select: { id: true } });
  if (existing && (await prisma.businessMember.findUnique({ where: { businessId_personId: { businessId: input.businessId, personId: existing.id } }, select: { personId: true } }))) {
    throw new DomainError("conflict", "That person is already on your team.");
  }
  const [size, pending, business] = await Promise.all([
    prisma.businessMember.count({ where: { businessId: input.businessId } }),
    prisma.businessInvite.count({ where: { businessId: input.businessId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } } }),
    prisma.business.findUnique({ where: { id: input.businessId }, select: { name: true } }),
  ]);
  if (!business) throw new DomainError("not_found", "Business not found");
  if (size >= MAX_TEAM_SIZE) throw new DomainError("conflict", "Your team has reached its size limit.");
  if (pending >= MAX_PENDING_INVITES) throw new DomainError("conflict", "Too many pending invitations. Revoke some first.");

  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);
  const invite = await prisma.$transaction(async (tx) => {
    await tx.businessInvite.updateMany({ where: { businessId: input.businessId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
    const i = await tx.businessInvite.create({
      data: { businessId: input.businessId, email, role, tokenHash: sha256(token), invitedByPersonId: input.actorPersonId, expiresAt },
      select: { id: true },
    });
    await emit(tx, "BuyerMemberInvited", { type: "business", id: input.businessId }, {
      businessId: input.businessId, inviteId: i.id, role, invitedByPersonId: input.actorPersonId, expiresAt: expiresAt.toISOString(),
    });
    return i;
  });
  return { inviteId: invite.id, token, email, role, expiresAt, businessName: business.name };
}

export async function revokeInvite(input: { businessId: string; actorPersonId: string; inviteId: string }, now = new Date()): Promise<void> {
  await requireCapability(input.actorPersonId, input.businessId, "team.manage");
  if (!UUID.test(input.inviteId)) throw new DomainError("not_found", "Invitation not found");
  const r = await prisma.businessInvite.updateMany({ where: { id: input.inviteId, businessId: input.businessId, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
  if (r.count === 0) throw new DomainError("not_found", "Invitation not found");
}

export interface InvitePreview {
  businessName: string;
  role: InvitableRole;
  /** masked, so a leaked link does not reveal the invited address */
  email: string;
  status: "pending" | "expired" | "used" | "revoked";
}

/** What an invitation link is for. Null for an unknown token (the same answer as any other invalid link). */
export async function previewInvite(token: string, now = new Date()): Promise<InvitePreview | null> {
  if (!token || token.length > 200) return null;
  const i = await prisma.businessInvite.findUnique({ where: { tokenHash: sha256(token) }, include: { business: { select: { name: true } } } });
  if (!i) return null;
  const status = i.acceptedAt ? "used" : i.revokedAt ? "revoked" : i.expiresAt.getTime() <= now.getTime() ? "expired" : "pending";
  return { businessName: i.business.name, role: i.role as InvitableRole, email: mask(i.email) ?? "***", status };
}

/** The signed-in person joins with the invited role. Their account email must be the invited address. */
export async function acceptInvite(token: string, personId: string, now = new Date()): Promise<{ businessId: string; role: InvitableRole }> {
  await enforceLimit(`team:accept:${personId}`, 10, 3600);
  const bad = () => new DomainError("not_found", "This invitation is not valid.");
  if (!token || token.length > 200) throw bad();
  const i = await prisma.businessInvite.findUnique({ where: { tokenHash: sha256(token) } });
  if (!i || i.revokedAt || i.acceptedAt) throw bad();
  if (i.expiresAt.getTime() <= now.getTime()) throw new DomainError("conflict", "This invitation has expired. Ask for a new one.");
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { email: true, erasedAt: true } });
  if (!person || person.erasedAt || !person.email || normaliseEmail(person.email) !== i.email) {
    throw new DomainError("forbidden", "Sign in with the email address this invitation was sent to.");
  }
  const role = i.role as InvitableRole;
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.businessInvite.updateMany({ where: { id: i.id, acceptedAt: null, revokedAt: null }, data: { acceptedAt: now, acceptedByPersonId: personId } });
    if (claimed.count === 0) throw bad(); // lost a race with another tab
    const existing = await tx.businessMember.findUnique({ where: { businessId_personId: { businessId: i.businessId, personId } }, select: { role: true } });
    if (existing) return; // already a member (e.g. invited twice): keep the current role, never downgrade an owner
    await tx.businessMember.create({ data: { businessId: i.businessId, personId, role } });
    await emit(tx, "BuyerMemberJoined", { type: "business", id: i.businessId }, { businessId: i.businessId, personId, role, inviteId: i.id });
  });
  return { businessId: i.businessId, role };
}

/** Owner/admin changes a member's role. Owners are never changed here (use transferOwnership); only owners touch admins. */
export async function changeMemberRole(input: { businessId: string; actorPersonId: string; targetPersonId: string; role: string }): Promise<void> {
  const actorRole = await requireCapability(input.actorPersonId, input.businessId, "team.manage");
  const role = roleSchema.parse(input.role);
  const target = await prisma.businessMember.findUnique({ where: { businessId_personId: { businessId: input.businessId, personId: input.targetPersonId } }, select: { role: true } });
  if (!target) throw new DomainError("not_found", "Member not found");
  const from = effectiveRole(target.role);
  if (from === "owner") throw new DomainError("forbidden", "Transfer ownership instead of changing the owner's role.");
  if ((from === "admin" || role === "admin") && actorRole !== "owner") throw new DomainError("forbidden", "Only the owner can grant or remove the admin role.");
  if (input.targetPersonId === input.actorPersonId && actorRole !== "owner") throw new DomainError("forbidden", "You cannot change your own role.");
  if (from === role && target.role !== "staff") return;
  await prisma.$transaction(async (tx) => {
    await tx.businessMember.update({ where: { businessId_personId: { businessId: input.businessId, personId: input.targetPersonId } }, data: { role } });
    await emit(tx, "BuyerMemberRoleChanged", { type: "business", id: input.businessId }, {
      businessId: input.businessId, personId: input.targetPersonId, from, to: role, changedByPersonId: input.actorPersonId,
    });
  });
}

/** Removes a member (or lets a non-owner leave). The owner can never be removed: transfer ownership first. */
export async function removeMember(input: { businessId: string; actorPersonId: string; targetPersonId: string }): Promise<void> {
  const self = input.actorPersonId === input.targetPersonId;
  const actorRole = self ? await getMemberRole(input.actorPersonId, input.businessId) : await requireCapability(input.actorPersonId, input.businessId, "team.manage");
  if (!actorRole) throw new DomainError("not_found", "Member not found");
  const target = await prisma.businessMember.findUnique({ where: { businessId_personId: { businessId: input.businessId, personId: input.targetPersonId } }, select: { role: true } });
  if (!target) throw new DomainError("not_found", "Member not found");
  const role = effectiveRole(target.role);
  if (role === "owner") throw new DomainError("forbidden", "The owner cannot be removed. Transfer ownership first.");
  if (role === "admin" && !self && actorRole !== "owner") throw new DomainError("forbidden", "Only the owner can remove an admin.");
  await prisma.$transaction(async (tx) => {
    await tx.businessMember.delete({ where: { businessId_personId: { businessId: input.businessId, personId: input.targetPersonId } } });
    await emit(tx, "BuyerMemberRemoved", { type: "business", id: input.businessId }, { businessId: input.businessId, personId: input.targetPersonId, removedByPersonId: input.actorPersonId });
  });
}

/**
 * Hands ownership to another member; the previous owner becomes an admin. Irreversible without the new owner's consent, so it needs
 * step-up (password, MFA code or a fresh OTP) exactly like account erasure.
 */
export async function transferOwnership(input: { businessId: string; actorPersonId: string; newOwnerPersonId: string; proof: ErasureStepUp }): Promise<void> {
  const actorRole = await getMemberRole(input.actorPersonId, input.businessId);
  if (actorRole !== "owner") throw new DomainError("forbidden", "Only the owner can transfer ownership.");
  if (input.newOwnerPersonId === input.actorPersonId) throw new DomainError("validation", "Choose another member.");
  const target = await prisma.businessMember.findUnique({ where: { businessId_personId: { businessId: input.businessId, personId: input.newOwnerPersonId } }, include: { person: { select: { erasedAt: true } } } });
  if (!target || target.person.erasedAt) throw new DomainError("not_found", "Member not found");
  await verifyErasureStepUp(input.actorPersonId, input.proof);
  await prisma.$transaction(async (tx) => {
    await tx.businessMember.update({ where: { businessId_personId: { businessId: input.businessId, personId: input.newOwnerPersonId } }, data: { role: "owner" } });
    await tx.businessMember.update({ where: { businessId_personId: { businessId: input.businessId, personId: input.actorPersonId } }, data: { role: "admin" } });
    await emit(tx, "BusinessOwnershipTransferred", { type: "business", id: input.businessId }, { businessId: input.businessId, fromPersonId: input.actorPersonId, toPersonId: input.newOwnerPersonId });
  });
}

