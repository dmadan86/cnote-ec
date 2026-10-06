// Right to nominate (DPDP Act 2023 s.14; Rules 2025 r.14): a data principal can nominate another individual who may exercise the
// principal's rights in the event of the principal's death or incapacity.
//
//  - The principal manages nominations from the account page. Add / change / revoke all require STEP-UP (password, MFA code or a fresh
//    OTP, identity's `verifyErasureStepUp`): a stolen session must not be able to hand the account to someone else.
//  - Name, contact and relationship are stored ENCRYPTED (field encryption, context bound to the row); `contactIndex` is a keyed blind
//    index so staff can match a request to a nomination without decrypting every row. Nothing here is ever logged or put in an event.
//  - The nominee has no account. They file a public request (`fileNomineeRequest`). The answer is identical whether or not the
//    principal exists or has nominated them (no enumeration of who has an account or a nominee).
//  - Staff verify: the requester MUST match an active nomination (a nominee the principal chose), and staff record which documents
//    (death certificate / guardianship order) they checked offline. Then staff complete it with an action (erase the account, release a
//    copy of the data, correction, other). Every staff step is wrapped in `audited()` by the admin app.
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { describePersonForStaff, erasePerson, findPersonIdByEmail, getOwnContacts, verifyErasureStepUp, type ErasureStepUp } from "@cnote/identity";
import { blindIndex, decryptField, encryptField } from "@cnote/security";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { grievancePolicy } from "./config";

export const MAX_ACTIVE_NOMINEES = 2;
export const NOMINEE_RELATIONSHIPS = ["spouse", "child", "parent", "sibling", "other_family", "legal_guardian", "friend", "other"] as const;
export type NomineeRelationship = (typeof NOMINEE_RELATIONSHIPS)[number];
export const NOMINEE_GROUNDS = ["death", "incapacity"] as const;
export type NomineeGround = (typeof NOMINEE_GROUNDS)[number];
export const NOMINEE_COMPLETE_ACTIONS = ["erase_account", "release_export", "correct", "other"] as const;
export type NomineeCompleteAction = (typeof NOMINEE_COMPLETE_ACTIONS)[number];

const INDEX_PURPOSE = "compliance.nominee_contact";
const ctx = (field: string, id: string) => `compliance.${field}:${id}`;

/** Canonical form of an email or phone for comparison. */
export function normalizeContact(raw: string): string {
  const v = raw.trim();
  if (v.includes("@")) return v.toLowerCase();
  const digits = v.replace(/[^\d+]/g, "");
  return digits.startsWith("+") ? digits : digits.length === 10 ? `+91${digits}` : digits.length === 12 && digits.startsWith("91") ? `+${digits}` : digits;
}
const CONTACT_RE = /^(?:[^\s@]+@[^\s@]+\.[^\s@]{2,}|\+\d{10,15})$/;
const contactSchema = z.string().trim().max(200).transform(normalizeContact).refine((c) => CONTACT_RE.test(c), "Enter a valid email address or mobile number");

const nomineeInput = z.object({
  name: z.string().trim().min(2, "Enter the nominee's full name").max(120),
  relationship: z.enum(NOMINEE_RELATIONSHIPS, "Choose the relationship"),
  contact: contactSchema,
});
export type NomineeInput = z.input<typeof nomineeInput>;

export interface NomineeView {
  id: string;
  name: string;
  relationship: NomineeRelationship;
  contact: string;
  createdAt: string;
  updatedAt: string;
}

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

async function decryptRow(r: { id: string; nameEnc: string; contactEnc: string; relationshipEnc: string; createdAt: Date; updatedAt: Date }): Promise<NomineeView> {
  const [name, contact, relationship] = await Promise.all([
    decryptField(r.nameEnc, ctx("nominee.name", r.id)),
    decryptField(r.contactEnc, ctx("nominee.contact", r.id)),
    decryptField(r.relationshipEnc, ctx("nominee.relationship", r.id)),
  ]);
  return { id: r.id, name, contact, relationship: relationship as NomineeRelationship, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

/** The person's own active nominations, decrypted for them. */
export async function listMyNominees(personId: string): Promise<NomineeView[]> {
  const rows = await prisma.dataNominee.findMany({ where: { personId, status: "active" }, orderBy: { createdAt: "asc" } });
  return Promise.all(rows.map(decryptRow));
}

async function assertNotSelf(personId: string, contact: string) {
  const own = await getOwnContacts(personId);
  if (own && [own.email, own.phone].filter(Boolean).map((c) => normalizeContact(c!)).includes(contact)) {
    throw new DomainError("validation", "You can't nominate yourself. Enter someone else's contact.", { field: "contact" });
  }
}

export async function addNominee(personId: string, input: NomineeInput, proof: ErasureStepUp): Promise<NomineeView> {
  const d = nomineeInput.parse(input);
  await verifyErasureStepUp(personId, proof);
  await assertNotSelf(personId, d.contact);
  const active = await prisma.dataNominee.findMany({ where: { personId, status: "active" }, select: { contactIndex: true } });
  if (active.length >= MAX_ACTIVE_NOMINEES) throw new DomainError("conflict", `You can have up to ${MAX_ACTIVE_NOMINEES} nominees. Remove one first.`);
  const contactIndex = blindIndex(d.contact, INDEX_PURPOSE);
  if (active.some((a) => a.contactIndex === contactIndex)) throw new DomainError("conflict", "That person is already your nominee.", { field: "contact" });
  const id = randomUUID();
  const [nameEnc, contactEnc, relationshipEnc] = await Promise.all([
    encryptField(clean(d.name), ctx("nominee.name", id)),
    encryptField(d.contact, ctx("nominee.contact", id)),
    encryptField(d.relationship, ctx("nominee.relationship", id)),
  ]);
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.dataNominee.create({ data: { id, personId, nameEnc, contactEnc, relationshipEnc, contactIndex } });
    await emit(tx, "DataNomineeChanged", { type: "Person", id: personId }, { personId, nomineeId: id, change: "added" });
    return r;
  });
  return decryptRow(row);
}

export async function changeNominee(personId: string, nomineeId: string, input: NomineeInput, proof: ErasureStepUp): Promise<NomineeView> {
  const d = nomineeInput.parse(input);
  await verifyErasureStepUp(personId, proof);
  const cur = await prisma.dataNominee.findFirst({ where: { id: nomineeId, personId, status: "active" } });
  if (!cur) throw new DomainError("not_found", "Nominee not found.");
  await assertNotSelf(personId, d.contact);
  const contactIndex = blindIndex(d.contact, INDEX_PURPOSE);
  const others = await prisma.dataNominee.count({ where: { personId, status: "active", contactIndex, id: { not: nomineeId } } });
  if (others) throw new DomainError("conflict", "That person is already your nominee.", { field: "contact" });
  const [nameEnc, contactEnc, relationshipEnc] = await Promise.all([
    encryptField(clean(d.name), ctx("nominee.name", nomineeId)),
    encryptField(d.contact, ctx("nominee.contact", nomineeId)),
    encryptField(d.relationship, ctx("nominee.relationship", nomineeId)),
  ]);
  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.dataNominee.update({ where: { id: nomineeId }, data: { nameEnc, contactEnc, relationshipEnc, contactIndex } });
    await emit(tx, "DataNomineeChanged", { type: "Person", id: personId }, { personId, nomineeId, change: "changed" });
    return r;
  });
  return decryptRow(row);
}

export async function revokeNominee(personId: string, nomineeId: string, proof: ErasureStepUp): Promise<void> {
  await verifyErasureStepUp(personId, proof);
  const cur = await prisma.dataNominee.findFirst({ where: { id: nomineeId, personId, status: "active" }, select: { id: true } });
  if (!cur) throw new DomainError("not_found", "Nominee not found.");
  await prisma.$transaction(async (tx) => {
    // Revoking drops the details at once (they are no longer needed); the row stays as a tombstone until the retention policy removes it.
    const junk = await encryptField("-", ctx("nominee.name", nomineeId));
    await tx.dataNominee.update({
      where: { id: nomineeId },
      data: { status: "revoked", revokedAt: new Date(), nameEnc: junk, contactEnc: await encryptField("-", ctx("nominee.contact", nomineeId)), relationshipEnc: await encryptField("-", ctx("nominee.relationship", nomineeId)), contactIndex: "revoked" },
    });
    await emit(tx, "DataNomineeChanged", { type: "Person", id: personId }, { personId, nomineeId, change: "revoked" });
  });
}

// ---- The nominee's request -------------------------------------------------------------------------------------------------

const requestInput = z.object({
  principalEmail: z.string().trim().toLowerCase().max(254),
  requesterName: z.string().trim().min(2, "Enter your full name").max(120),
  requesterContact: contactSchema,
  ground: z.enum(NOMINEE_GROUNDS, "Choose death or incapacity"),
  message: z.string().trim().min(10, "Describe what you are asking for (at least 10 characters)").max(3000),
});
export type NomineeRequestInput = z.input<typeof requestInput>;

/**
 * Public intake. Returns only a reference: the answer never reveals whether the account exists or whether this person is a nominee.
 * The 90-day clock for rights requests (DPDP Rules 2025) starts now.
 */
export async function fileNomineeRequest(input: NomineeRequestInput, now = new Date()): Promise<{ id: string; dueAt: string }> {
  const d = requestInput.parse(input);
  const personId = d.principalEmail.includes("@") ? await findPersonIdByEmail(d.principalEmail) : null;
  const contactIndex = blindIndex(d.requesterContact, INDEX_PURPOSE);
  const matched = personId ? (await prisma.dataNominee.count({ where: { personId, status: "active", contactIndex } })) > 0 : false;
  const id = randomUUID();
  const dueAt = new Date(now.getTime() + grievancePolicy().rightsRequestDays * 86_400_000);
  await prisma.nomineeRequest.create({
    data: {
      id,
      personId,
      requesterNameEnc: await encryptField(clean(d.requesterName), ctx("nominee_request.name", id)),
      requesterContactEnc: await encryptField(d.requesterContact, ctx("nominee_request.contact", id)),
      messageEnc: await encryptField(d.message, ctx("nominee_request.message", id)),
      contactIndex,
      ground: d.ground,
      nomineeMatched: matched,
      dueAt,
    },
  });
  return { id, dueAt: dueAt.toISOString() };
}

// ---- Staff workflow --------------------------------------------------------------------------------------------------------

export type NomineeRequestStatus = "received" | "verified" | "rejected" | "completed";

export interface NomineeRequestSummary {
  id: string;
  status: NomineeRequestStatus;
  ground: NomineeGround;
  nomineeMatched: boolean;
  principalFound: boolean;
  dueAt: string;
  overdue: boolean;
  createdAt: string;
}

export async function listNomineeRequests(o: { status?: NomineeRequestStatus; limit?: number } = {}, now = new Date()): Promise<NomineeRequestSummary[]> {
  const rows = await prisma.nomineeRequest.findMany({
    where: o.status ? { status: o.status } : {},
    orderBy: [{ dueAt: "asc" }],
    take: Math.min(Math.max(o.limit ?? 100, 1), 500),
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status as NomineeRequestStatus,
    ground: r.ground as NomineeGround,
    nomineeMatched: r.nomineeMatched,
    principalFound: !!r.personId,
    dueAt: r.dueAt.toISOString(),
    overdue: (r.status === "received" || r.status === "verified") && r.dueAt < now,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface NomineeRequestDetail extends NomineeRequestSummary {
  requesterName: string;
  requesterContact: string;
  message: string;
  principal: { emailMasked: string | null; erased: boolean; createdAt: string; lastActiveAt: string | null } | null;
  /** the principal's active nominations, for comparing the requester against (privileged read: the admin app audits it) */
  registeredNominees: { name: string; relationship: string; contactMatches: boolean }[];
  reviewNote: string | null;
  actionTaken: string | null;
  actionNote: string | null;
}

export async function getNomineeRequest(id: string, now = new Date()): Promise<NomineeRequestDetail | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const r = await prisma.nomineeRequest.findUnique({ where: { id } });
  if (!r) return null;
  const [requesterName, requesterContact, message, principal, noms] = await Promise.all([
    decryptField(r.requesterNameEnc, ctx("nominee_request.name", r.id)),
    decryptField(r.requesterContactEnc, ctx("nominee_request.contact", r.id)),
    decryptField(r.messageEnc, ctx("nominee_request.message", r.id)),
    r.personId ? describePersonForStaff(r.personId) : Promise.resolve(null),
    r.personId ? prisma.dataNominee.findMany({ where: { personId: r.personId, status: "active" } }) : Promise.resolve([]),
  ]);
  const registeredNominees = await Promise.all(
    noms.map(async (n) => {
      const v = await decryptRow(n);
      return { name: v.name, relationship: v.relationship, contactMatches: n.contactIndex === r.contactIndex };
    }),
  );
  return {
    id: r.id,
    status: r.status as NomineeRequestStatus,
    ground: r.ground as NomineeGround,
    nomineeMatched: r.nomineeMatched,
    principalFound: !!r.personId,
    dueAt: r.dueAt.toISOString(),
    overdue: (r.status === "received" || r.status === "verified") && r.dueAt < now,
    createdAt: r.createdAt.toISOString(),
    requesterName,
    requesterContact,
    message,
    principal: principal ? { emailMasked: principal.emailMasked, erased: principal.erased, createdAt: principal.createdAt.toISOString(), lastActiveAt: principal.lastActiveAt?.toISOString() ?? null } : null,
    registeredNominees,
    reviewNote: r.reviewNote,
    actionTaken: r.actionTaken,
    actionNote: r.actionNote,
  };
}

const noteSchema = z.string().trim().min(5, "Describe the documents you checked (at least 5 characters)").max(1000);

/**
 * Staff decision. "verified" is possible ONLY when the requester matches an active nomination of the principal (re-checked now, in case
 * the principal revoked it meanwhile) and the note says which documents were checked offline. Anything else can only be rejected.
 */
export async function decideNomineeRequest(id: string, decision: "verified" | "rejected", note: string, staffId: string, now = new Date()): Promise<void> {
  const n = noteSchema.parse(note);
  const r = await prisma.nomineeRequest.findUnique({ where: { id } });
  if (!r) throw new DomainError("not_found", "Request not found.");
  if (r.status !== "received") throw new DomainError("conflict", "This request was already decided.");
  if (decision === "verified") {
    const stillMatched = !!r.personId && (await prisma.dataNominee.count({ where: { personId: r.personId, status: "active", contactIndex: r.contactIndex } })) > 0;
    if (!stillMatched) throw new DomainError("validation", "Only a requester who matches an active nomination of the account holder can be verified. Reject this request.");
  }
  const res = await prisma.nomineeRequest.updateMany({ where: { id, status: "received" }, data: { status: decision, reviewNote: n, reviewedBy: staffId, reviewedAt: now } });
  if (res.count !== 1) throw new DomainError("conflict", "This request was already decided.");
}

/** Staff completes a VERIFIED request with the action taken. "erase_account" erases the principal's account (identity's erasePerson). */
export async function completeNomineeRequest(id: string, action: NomineeCompleteAction, note: string, staffId: string, now = new Date()): Promise<void> {
  if (!NOMINEE_COMPLETE_ACTIONS.includes(action)) throw new DomainError("validation", "Choose an action.");
  const n = z.string().trim().min(3, "Add a short note on what was done").max(1000).parse(note);
  const r = await prisma.nomineeRequest.findUnique({ where: { id } });
  if (!r) throw new DomainError("not_found", "Request not found.");
  if (r.status !== "verified" || !r.personId) throw new DomainError("conflict", "Only a verified request can be completed.");
  const claimed = await prisma.nomineeRequest.updateMany({ where: { id, status: "verified" }, data: { status: "completed", actionTaken: action, actionNote: n, completedAt: now, reviewedBy: staffId } });
  if (claimed.count !== 1) throw new DomainError("conflict", "This request was already completed.");
  if (action === "erase_account") await erasePerson(r.personId);
}

/** Data the principal can see about nominations (their own export). Requests by nominees are listed without the requester's details. */
export async function exportNomineeData(personId: string): Promise<Record<string, unknown>> {
  const [nominees, requests] = await Promise.all([
    prisma.dataNominee.findMany({ where: { personId }, orderBy: { createdAt: "asc" }, take: 20 }),
    prisma.nomineeRequest.findMany({ where: { personId }, orderBy: { createdAt: "asc" }, take: 50, select: { ground: true, status: true, createdAt: true, completedAt: true, actionTaken: true } }),
  ]);
  const out: Record<string, unknown>[] = [];
  for (const n of nominees) {
    if (n.status === "active") {
      const v = await decryptRow(n);
      out.push({ id: v.id, status: "active", name: v.name, relationship: v.relationship, contact: v.contact, createdAt: v.createdAt, updatedAt: v.updatedAt });
    } else out.push({ id: n.id, status: "revoked", createdAt: n.createdAt.toISOString(), revokedAt: n.revokedAt?.toISOString() ?? null });
  }
  return { nominees: { items: out }, nomineeRequests: { items: requests } };
}

/** Erasure of the principal: the nominations go with them (the requests stay, as evidence, until their retention window). */
export async function deleteNomineesForPerson(personId: string): Promise<number> {
  return (await prisma.dataNominee.deleteMany({ where: { personId } })).count;
}

/** Retention: decided requests and revoked nominations older than `before`. */
export async function purgeDecidedNomineeRequests(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const reqWhere = { status: { in: ["rejected", "completed"] }, OR: [{ completedAt: { lt: before } }, { completedAt: null, reviewedAt: { lt: before } }] };
  const nomWhere = { status: "revoked", revokedAt: { lt: before } };
  if (opts.dryRun) return (await prisma.nomineeRequest.count({ where: reqWhere })) + (await prisma.dataNominee.count({ where: nomWhere }));
  const a = await prisma.nomineeRequest.deleteMany({ where: reqWhere });
  const b = await prisma.dataNominee.deleteMany({ where: nomWhere });
  return a.count + b.count;
}
