"use server";
// Buyer team + approvals server actions (docs/design/buyer-approvals.md). Each re-checks the session and the member's role in the
// domain module: server actions are reachable by direct POST. Failure text is localised from the `approvals` catalogue by error key.
import {
  cancelRequest, createDelegation, decide, deletePolicy, revokeDelegation, savePolicy, setPolicyEnabled, setSpendLimit,
  APPROVER_ROLES, type ApprovalActionName, type ApproverRole,
} from "@cnote/approvals";
import { sendEmail } from "@cnote/email";
import {
  acceptInvite, changeMemberRole, inviteMember, removeMember, revokeInvite, transferOwnership, INVITE_TTL_DAYS,
} from "@cnote/identity";
import { requireBusiness, requireSession, type ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { runLocalized } from "@/i18n/errors";
import { getRequestLocale } from "@/lib/request-locale";
import { localizeApprovalError } from "@/features/approvals/localize";

const TEAM = "/account/team";
const RULES = "/account/approvals";
const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const strs = (f: FormData, k: string) => f.getAll(k).filter((v): v is string => typeof v === "string" && v !== "");
/** ₹ typed by a person -> integer paise; blank is 0, anything unparsable is NaN (the module rejects it). */
const paise = (f: FormData, k: string): number => {
  const raw = str(f, k).replace(/[,\s₹]/g, "");
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : Number.NaN;
};

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  return localizeApprovalError(await runLocalized(fn));
}

// ---- team ----------------------------------------------------------------------------------------------------------------

export async function inviteMemberAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(TEAM);
  const locale = await getRequestLocale();
  const r = await run(async () => {
    const inv = await inviteMember({ businessId: s.business.id, actorPersonId: s.personId, email: str(f, "email"), role: str(f, "role") });
    const t = await getTranslations({ locale, namespace: "approvals" });
    const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
    // The copy lives in the DB template "team.invite" (template studio); the single-use token only ever travels in this email.
    await sendEmail({
      template: "team.invite",
      to: { email: inv.email },
      vars: { businessName: inv.businessName, role: t(`roles.${inv.role}`), inviteUrl: `${base}${TEAM}/accept?token=${encodeURIComponent(inv.token)}`, expiresInDays: String(INVITE_TTL_DAYS) },
      locale,
      dedupeKey: `team-invite:${inv.inviteId}`,
    });
  });
  if (r.ok) revalidatePath(TEAM);
  return r;
}

export async function revokeInviteAction(f: FormData): Promise<void> {
  const s = await requireBusiness(TEAM);
  await run(() => revokeInvite({ businessId: s.business.id, actorPersonId: s.personId, inviteId: str(f, "inviteId") }));
  revalidatePath(TEAM);
}

export async function changeRoleAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(TEAM);
  const r = await run(() => changeMemberRole({ businessId: s.business.id, actorPersonId: s.personId, targetPersonId: str(f, "personId"), role: str(f, "role") }));
  if (r.ok) revalidatePath(TEAM);
  return r;
}

export async function removeMemberAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(TEAM);
  const r = await run(() => removeMember({ businessId: s.business.id, actorPersonId: s.personId, targetPersonId: str(f, "personId") }));
  if (r.ok) revalidatePath(TEAM);
  return r;
}

/** Owner transfer: needs step-up (password, or authenticator/recovery code when MFA is on). */
export async function transferOwnershipAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(TEAM);
  const r = await run(() =>
    transferOwnership({ businessId: s.business.id, actorPersonId: s.personId, newOwnerPersonId: str(f, "newOwner"), proof: { password: str(f, "password") || undefined, mfaCode: str(f, "mfaCode") || undefined } }),
  );
  if (r.ok) revalidatePath(TEAM);
  return r;
}

export async function acceptInviteAction(_prev: ActionResult<{ businessId: string }> | null, f: FormData): Promise<ActionResult<{ businessId: string }>> {
  const token = str(f, "token");
  const s = await requireSession(`${TEAM}/accept?token=${encodeURIComponent(token)}`);
  const r = await run(async () => ({ businessId: (await acceptInvite(token, s.personId)).businessId }));
  if (r.ok) revalidatePath(TEAM);
  return r;
}

// ---- rules, delegation, spend limits ---------------------------------------------------------------------------------------

export async function savePolicyAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(RULES);
  const levels: { role: ApproverRole; personIds: string[]; minAmountPaise: number }[] = [];
  for (let i = 1; i <= 3; i++) {
    const role = str(f, `level${i}Role`);
    if (!role) continue;
    levels.push({ role: (APPROVER_ROLES as readonly string[]).includes(role) ? (role as ApproverRole) : ("approver" as ApproverRole), personIds: strs(f, `level${i}People`), minAmountPaise: paise(f, `level${i}Min`) });
  }
  const r = await run(() =>
    savePolicy(s.business.id, s.personId, { id: str(f, "id") || undefined, name: str(f, "name"), action: str(f, "action") as ApprovalActionName, minAmountPaise: paise(f, "threshold"), enabled: true, levels }),
  );
  if (r.ok) revalidatePath(RULES);
  return r.ok ? { ok: true, data: undefined } : r;
}

export async function togglePolicyAction(f: FormData): Promise<void> {
  const s = await requireBusiness(RULES);
  await run(() => setPolicyEnabled(s.business.id, s.personId, str(f, "id"), str(f, "enabled") === "true"));
  revalidatePath(RULES);
}

export async function deletePolicyAction(f: FormData): Promise<void> {
  const s = await requireBusiness(RULES);
  await run(() => deletePolicy(s.business.id, s.personId, str(f, "id")));
  revalidatePath(RULES);
}

export async function createDelegationAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(RULES);
  const start = str(f, "startsAt");
  const end = str(f, "endsAt");
  // dates are IST calendar days: from the start of the first day to the end of the last
  const r = await run(() =>
    createDelegation({ businessId: s.business.id, delegatorPersonId: s.personId, delegatePersonId: str(f, "delegate"), startsAt: new Date(`${start || "invalid"}T00:00:00+05:30`), endsAt: new Date(`${end || "invalid"}T23:59:59+05:30`) }),
  );
  if (r.ok) revalidatePath(RULES);
  return r.ok ? { ok: true, data: undefined } : r;
}

export async function revokeDelegationAction(f: FormData): Promise<void> {
  const s = await requireBusiness(RULES);
  await run(() => revokeDelegation({ businessId: s.business.id, actorPersonId: s.personId, delegationId: str(f, "id") }));
  revalidatePath(RULES);
}

export async function setSpendLimitAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireBusiness(RULES);
  const blank = str(f, "cap") === "";
  const r = await run(() => setSpendLimit({ businessId: s.business.id, actorPersonId: s.personId, personId: str(f, "personId"), monthlyCapPaise: blank ? null : paise(f, "cap") }));
  if (r.ok) revalidatePath(RULES);
  return r.ok ? { ok: true, data: undefined } : r;
}

// ---- deciding ------------------------------------------------------------------------------------------------------------

export async function decideAction(_prev: ActionResult<{ status: string }> | null, f: FormData): Promise<ActionResult<{ status: string }>> {
  const id = str(f, "requestId");
  const s = await requireBusiness(`/buyer/approvals/${id}`);
  const decision = str(f, "decision");
  const r = await run(async () => {
    if (decision !== "approve" && decision !== "reject") throw new Error("invalid decision");
    return { status: (await decide({ requestId: id, deciderId: s.personId, decision, comment: str(f, "comment") })).status };
  });
  if (r.ok) {
    revalidatePath("/buyer/approvals");
    revalidatePath(`/buyer/approvals/${id}`);
  }
  return r;
}

export async function cancelRequestAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const id = str(f, "requestId");
  const s = await requireBusiness(`/buyer/approvals/${id}`);
  const r = await run(() => cancelRequest({ requestId: id, actorId: s.personId }));
  if (r.ok) {
    revalidatePath("/buyer/approvals");
    revalidatePath(`/buyer/approvals/${id}`);
  }
  return r;
}
