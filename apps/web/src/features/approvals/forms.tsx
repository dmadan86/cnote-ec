"use client";
// Forms for the buyer team and approvals screens. Every control has a visible label, errors are announced (Field / Alert role),
// and results are exposed in a polite live region (WCAG 2.2 AA). Copy comes from the `approvals` catalogue (en + hi).
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Input, Select, Textarea } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  acceptInviteAction, cancelRequestAction, changeRoleAction, createDelegationAction, decideAction, inviteMemberAction, removeMemberAction, savePolicyAction, setSpendLimitAction, transferOwnershipAction,
} from "./actions";

type S = ActionResult | null;
const fe = (s: S, k: string) => (s && !s.ok ? s.fieldErrors?.[k] : undefined);
function Result({ state, ok }: { state: S; ok: string }) {
  if (!state) return <div role="status" aria-live="polite" className="sr-only" />;
  if (state.ok) return <Alert tone="success">{ok}</Alert>;
  return state.fieldErrors ? null : <Alert tone="danger">{state.error}</Alert>;
}

export const INVITABLE = ["admin", "requester", "approver", "finance", "viewer"] as const;
const ROLE_SELECT_CLS = "min-w-36";

export function InviteForm({ canInviteAdmin }: { canInviteAdmin: boolean }) {
  const t = useTranslations("approvals");
  const [state, action, pending] = useActionState<S, FormData>(inviteMemberAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Result state={state} ok={t("team.inviteSent")} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <Field label={t("team.inviteEmail")} htmlFor="invite-email" error={fe(state, "email")}>
          <Input id="invite-email" name="email" type="email" autoComplete="off" inputMode="email" required />
        </Field>
        <Field label={t("team.inviteRole")} htmlFor="invite-role" hint={t("team.inviteRoleHint")}>
          <Select id="invite-role" name="role" defaultValue="requester">
            {INVITABLE.filter((r) => r !== "admin" || canInviteAdmin).map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
          </Select>
        </Field>
      </div>
      <div><Button type="submit" disabled={pending}>{pending ? t("team.sending") : t("team.sendInvite")}</Button></div>
    </form>
  );
}

export function MemberControls({ personId, name, role, storedRole, canEditRole, canRemove, canInviteAdmin, isSelf }: {
  personId: string; name: string; role: string; storedRole: string; canEditRole: boolean; canRemove: boolean; canInviteAdmin: boolean; isSelf: boolean;
}) {
  const t = useTranslations("approvals");
  const [roleState, roleAction, rolePending] = useActionState<S, FormData>(changeRoleAction, null);
  const [removeState, removeAction, removePending] = useActionState<S, FormData>(removeMemberAction, null);
  const [confirm, setConfirm] = useState(false);
  const id = `role-${personId}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        {canEditRole ? (
          <form action={roleAction} className="flex items-end gap-2">
            <input type="hidden" name="personId" value={personId} />
            <div className="flex flex-col gap-1">
              <label htmlFor={id} className="text-xs font-medium text-muted">{t("team.roleFor", { name })}</label>
              <Select id={id} name="role" defaultValue={role} className={ROLE_SELECT_CLS}>
                {INVITABLE.filter((r) => r !== "admin" || canInviteAdmin || role === "admin").map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
              </Select>
            </div>
            <Button type="submit" variant="outline" size="sm" disabled={rolePending} aria-label={t("team.saveRoleFor", { name })}>{t("team.saveRole")}</Button>
          </form>
        ) : (
          <span className="text-sm text-ink">{t(`roles.${role}`)}{storedRole === "staff" ? ` (${t("team.legacy")})` : ""}</span>
        )}
        {canRemove ? (
          confirm ? (
            <form action={removeAction} className="flex items-center gap-2">
              <input type="hidden" name="personId" value={personId} />
              <Button type="submit" variant="danger" size="sm" disabled={removePending}>{isSelf ? t("team.confirmLeave") : t("team.confirmRemove", { name })}</Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
            </form>
          ) : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirm(true)} aria-label={isSelf ? t("team.leave") : t("team.removeFor", { name })}>{isSelf ? t("team.leave") : t("team.remove")}</Button>
          )
        ) : null}
      </div>
      <Result state={roleState} ok={t("team.roleSaved")} />
      <Result state={removeState} ok={t("team.removed")} />
    </div>
  );
}

export function TransferOwnershipForm({ members }: { members: { personId: string; label: string }[] }) {
  const t = useTranslations("approvals");
  const [state, action, pending] = useActionState<S, FormData>(transferOwnershipAction, null);
  if (members.length === 0) return <p className="text-sm text-muted">{t("team.transferNoMembers")}</p>;
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Result state={state} ok={t("team.transferred")} />
      <Field label={t("team.transferTo")} htmlFor="transfer-to">
        <Select id="transfer-to" name="newOwner" required defaultValue="">
          <option value="" disabled>{t("team.choose")}</option>
          {members.map((m) => <option key={m.personId} value={m.personId}>{m.label}</option>)}
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("team.stepUpPassword")} htmlFor="transfer-password" hint={t("team.stepUpHint")}>
          <Input id="transfer-password" name="password" type="password" autoComplete="current-password" />
        </Field>
        <Field label={t("team.stepUpMfa")} htmlFor="transfer-mfa">
          <Input id="transfer-mfa" name="mfaCode" inputMode="numeric" autoComplete="one-time-code" />
        </Field>
      </div>
      <p className="text-sm text-muted">{t("team.transferWarning")}</p>
      <div><Button type="submit" variant="danger" disabled={pending}>{t("team.transferSubmit")}</Button></div>
    </form>
  );
}

export function AcceptInviteForm({ token }: { token: string }) {
  const t = useTranslations("approvals");
  const [state, action, pending] = useActionState(acceptInviteAction, null);
  return (
    <form action={action} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      {state?.ok ? <Alert tone="success">{t("accept.done")}</Alert> : state ? <Alert tone="danger">{state.error}</Alert> : <div role="status" aria-live="polite" className="sr-only" />}
      <div><Button type="submit" disabled={pending || !!state?.ok}>{t("accept.submit")}</Button></div>
    </form>
  );
}

// ---- rules -----------------------------------------------------------------------------------------------------------------

export interface PolicyFormValue {
  id?: string;
  name: string;
  action: string;
  thresholdRupees: string;
  levels: { role: string; personIds: string[]; minRupees: string }[];
}
const APPROVER_ROLES = ["approver", "finance", "admin", "owner"] as const;
const ACTIONS = ["rfq_publish", "quote_accept", "order_confirm", "po_issue"] as const;

export function PolicyForm({ members, initial, onDone }: { members: { personId: string; label: string }[]; initial?: PolicyFormValue; onDone?: () => void }) {
  const t = useTranslations("approvals");
  const [levelCount, setLevelCount] = useState(Math.max(1, initial?.levels.length ?? 1));
  const [state, action, pending] = useActionState<S, FormData>(async (prev, fd) => {
    const r = await savePolicyAction(prev, fd);
    if (r.ok) onDone?.();
    return r;
  }, null);
  const k = initial?.id ?? "new";
  return (
    <form action={action} className="flex flex-col gap-4 rounded-lg border border-line p-4" noValidate aria-label={initial ? t("rules.editTitle") : t("rules.addTitle")}>
      <h3 className="text-sm font-semibold text-ink">{initial ? t("rules.editTitle") : t("rules.addTitle")}</h3>
      <Result state={state} ok={t("rules.saved")} />
      {initial?.id ? <input type="hidden" name="id" value={initial.id} /> : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("rules.name")} htmlFor={`${k}-name`} error={fe(state, "name")}>
          <Input id={`${k}-name`} name="name" defaultValue={initial?.name ?? ""} maxLength={80} required />
        </Field>
        <Field label={t("rules.action")} htmlFor={`${k}-action`}>
          <Select id={`${k}-action`} name="action" defaultValue={initial?.action ?? "quote_accept"}>
            {ACTIONS.map((a) => <option key={a} value={a}>{t(`actions.${a}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("rules.threshold")} htmlFor={`${k}-threshold`} hint={t("rules.thresholdHint")}>
          <Input id={`${k}-threshold`} name="threshold" inputMode="decimal" defaultValue={initial?.thresholdRupees ?? "0"} />
        </Field>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-ink">{t("rules.chain")}</legend>
        <p className="text-xs text-muted">{t("rules.chainHint")}</p>
        {Array.from({ length: levelCount }, (_, i) => {
          const n = i + 1;
          const lv = initial?.levels[i];
          return (
            <div key={n} className="grid gap-3 rounded-lg bg-canvas p-3 sm:grid-cols-3">
              <Field label={t("rules.levelRole", { n })} htmlFor={`${k}-l${n}-role`}>
                <Select id={`${k}-l${n}-role`} name={`level${n}Role`} defaultValue={lv?.role ?? "approver"}>
                  {APPROVER_ROLES.map((r) => <option key={r} value={r}>{t(`roles.${r}`)}</option>)}
                </Select>
              </Field>
              <Field label={t("rules.levelPeople", { n })} htmlFor={`${k}-l${n}-people`} hint={t("rules.levelPeopleHint")}>
                <Select id={`${k}-l${n}-people`} name={`level${n}People`} multiple defaultValue={lv?.personIds ?? []} className="h-24 lg:h-24">
                  {members.map((m) => <option key={m.personId} value={m.personId}>{m.label}</option>)}
                </Select>
              </Field>
              <Field label={t("rules.levelMin", { n })} htmlFor={`${k}-l${n}-min`} hint={t("rules.levelMinHint")}>
                <Input id={`${k}-l${n}-min`} name={`level${n}Min`} inputMode="decimal" defaultValue={lv?.minRupees ?? "0"} />
              </Field>
            </div>
          );
        })}
        <div className="flex gap-2">
          {levelCount < 3 ? <Button type="button" variant="outline" size="sm" onClick={() => setLevelCount((c) => c + 1)}>{t("rules.addLevel")}</Button> : null}
          {levelCount > 1 ? <Button type="button" variant="ghost" size="sm" onClick={() => setLevelCount((c) => c - 1)}>{t("rules.removeLevel")}</Button> : null}
        </div>
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>{pending ? t("common.saving") : t("common.save")}</Button>
        {onDone ? <Button type="button" variant="ghost" onClick={onDone}>{t("common.cancel")}</Button> : null}
      </div>
    </form>
  );
}

export function DelegationForm({ members }: { members: { personId: string; label: string }[] }) {
  const t = useTranslations("approvals");
  const [state, action, pending] = useActionState<S, FormData>(createDelegationAction, null);
  return (
    <form action={action} className="flex flex-col gap-4" noValidate>
      <Result state={state} ok={t("delegation.saved")} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t("delegation.to")} htmlFor="deleg-to">
          <Select id="deleg-to" name="delegate" required defaultValue="">
            <option value="" disabled>{t("team.choose")}</option>
            {members.map((m) => <option key={m.personId} value={m.personId}>{m.label}</option>)}
          </Select>
        </Field>
        <Field label={t("delegation.from")} htmlFor="deleg-from"><Input id="deleg-from" name="startsAt" type="date" required /></Field>
        <Field label={t("delegation.until")} htmlFor="deleg-until"><Input id="deleg-until" name="endsAt" type="date" required /></Field>
      </div>
      <div><Button type="submit" disabled={pending}>{t("delegation.submit")}</Button></div>
    </form>
  );
}

export function SpendLimitForm({ personId, name, capRupees }: { personId: string; name: string; capRupees: string }) {
  const t = useTranslations("approvals");
  const [state, action, pending] = useActionState<S, FormData>(setSpendLimitAction, null);
  const id = `cap-${personId}`;
  return (
    <form action={action} className="flex flex-wrap items-end gap-2" noValidate>
      <input type="hidden" name="personId" value={personId} />
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-xs font-medium text-muted">{t("spend.capFor", { name })}</label>
        <Input id={id} name="cap" inputMode="decimal" defaultValue={capRupees} placeholder={t("spend.noLimit")} className="w-40" />
      </div>
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={t("spend.saveFor", { name })}>{t("common.save")}</Button>
      <Result state={state} ok={t("spend.saved")} />
    </form>
  );
}

// ---- deciding ------------------------------------------------------------------------------------------------------------

export function DecisionForm({ requestId }: { requestId: string }) {
  const t = useTranslations("approvals");
  const [state, action, pending] = useActionState(decideAction, null);
  if (state?.ok) return <Alert tone="success">{state.data.status === "rejected" ? t("decide.doneRejected") : state.data.status === "approved" ? t("decide.doneApproved") : t("decide.doneNext")}</Alert>;
  return (
    <form action={action} className="flex flex-col gap-3" noValidate>
      <input type="hidden" name="requestId" value={requestId} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : <div role="status" aria-live="polite" className="sr-only" />}
      <Field label={t("decide.comment")} htmlFor={`comment-${requestId}`} hint={t("decide.commentHint")}>
        <Textarea id={`comment-${requestId}`} name="comment" maxLength={1000} rows={3} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" name="decision" value="approve" disabled={pending}>{t("decide.approve")}</Button>
        <Button type="submit" name="decision" value="reject" variant="danger" disabled={pending}>{t("decide.reject")}</Button>
      </div>
    </form>
  );
}

export function CancelRequestForm({ requestId }: { requestId: string }) {
  const t = useTranslations("approvals");
  const [state, action, pending] = useActionState<S, FormData>(cancelRequestAction, null);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="requestId" value={requestId} />
      <Result state={state} ok={t("decide.withdrawn")} />
      <div><Button type="submit" variant="outline" disabled={pending}>{t("decide.withdraw")}</Button></div>
    </form>
  );
}
