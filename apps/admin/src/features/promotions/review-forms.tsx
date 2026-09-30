"use client";
import { useState } from "react";
import { Field, Input, Select } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  activateCouponAction, createCouponAction, decideHonourAction, pauseCouponAction, rejectReferralAction, releaseReferralAction, reviewOfferAction, suspendOfferAction, voidRedemptionAction,
} from "./actions";

export function OfferReviewForm({ id }: { id: string }) {
  return (
    <ActionForm action={reviewOfferAction} successMessage="Decision saved.">
      <input type="hidden" name="id" value={id} />
      <label htmlFor={`note-${id}`} className="block text-xs text-muted">Note (required to reject; shown to the seller)</label>
      <Input id={`note-${id}`} name="note" maxLength={500} className="mb-2" />
      <div className="flex gap-2">
        <SubmitButton size="sm" name="decision" value="approve">Approve</SubmitButton>
        <SubmitButton size="sm" variant="danger" name="decision" value="reject">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function SuspendOfferForm({ id }: { id: string }) {
  return (
    <ActionForm action={suspendOfferAction} confirm="Suspend this offer now? It disappears from the site immediately." successMessage="Suspended.">
      <input type="hidden" name="id" value={id} />
      <div className="flex items-end gap-2">
        <div><label htmlFor={`sus-${id}`} className="block text-xs text-muted">Reason (required)</label><Input id={`sus-${id}`} name="note" required maxLength={500} /></div>
        <SubmitButton size="sm" variant="danger">Suspend</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function HonourDecisionForm({ id }: { id: string }) {
  return (
    <ActionForm action={decideHonourAction} confirm="Record this decision? Upheld reports lower the seller's trust signal." successMessage="Decision recorded.">
      <input type="hidden" name="id" value={id} />
      <div className="flex gap-2">
        <SubmitButton size="sm" variant="danger" name="decision" value="upheld">Uphold (seller did not honour)</SubmitButton>
        <SubmitButton size="sm" variant="outline" name="decision" value="dismissed">Dismiss</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function CouponCreateForm({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [kind, setKind] = useState("percent");
  return (
    <ActionForm action={createCouponAction} successMessage="Coupon created as a draft. Activate it below." className="space-y-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Name" htmlFor="c-name"><Input id="c-name" name="name" required maxLength={120} /></Field>
        <Field label="Code (optional)" htmlFor="c-code" hint="Empty = random 12 characters, best for targeted campaigns."><Input id="c-code" name="code" maxLength={32} /></Field>
        <Field label="Type" htmlFor="c-kind">
          <Select id="c-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="percent">Percent off</option><option value="flat">Flat amount off</option><option value="extra_credits">Bonus lead credits</option>
            {isSuperAdmin ? <option value="ad_credit">Ad credit (super admin)</option> : null}
          </Select>
        </Field>
        {kind === "percent" ? (<><Field label="Percent (e.g. 20)" htmlFor="c-pct"><Input id="c-pct" name="percent" inputMode="decimal" required /></Field><Field label="Max discount (₹, optional)" htmlFor="c-max"><Input id="c-max" name="maxDiscount" inputMode="decimal" /></Field></>) : null}
        {kind === "flat" || kind === "ad_credit" ? <Field label="Amount (₹)" htmlFor="c-val"><Input id="c-val" name="value" inputMode="decimal" required /></Field> : null}
        {kind === "extra_credits" ? <Field label="Credits" htmlFor="c-cr"><Input id="c-cr" name="extraCredits" inputMode="numeric" required /></Field> : null}
        <Field label="Plans (comma separated, empty = all paid)" htmlFor="c-plans"><Input id="c-plans" name="planCodes" placeholder="starter, pro" /></Field>
        <Field label="Valid from (IST)" htmlFor="c-from"><Input id="c-from" name="validFrom" type="datetime-local" required /></Field>
        <Field label="Valid to (IST)" htmlFor="c-to"><Input id="c-to" name="validTo" type="datetime-local" required /></Field>
        <Field label="Total redemptions (empty = unlimited)" htmlFor="c-max-r"><Input id="c-max-r" name="maxRedemptions" inputMode="numeric" /></Field>
        <Field label="Per business" htmlFor="c-per"><Input id="c-per" name="perBusinessLimit" inputMode="numeric" defaultValue={1} /></Field>
        <Field label="Minimum verification tier" htmlFor="c-tier"><Input id="c-tier" name="minTier" inputMode="numeric" defaultValue={1} /></Field>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="firstPurchaseOnly" defaultChecked className="size-4" /> First purchase only</label>
      <p className="text-xs text-muted">Discounts apply to the first billing period only and never stack. Above 50%, Rs 5,000 or 200 credits (and all ad credit) a second staff member must activate the coupon.</p>
      <SubmitButton>Create draft coupon</SubmitButton>
    </ActionForm>
  );
}

export function CouponRowActions({ id, status }: { id: string; status: string }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {status === "draft" || status === "paused" ? (
        <ActionForm action={activateCouponAction} successMessage="Active."><input type="hidden" name="id" value={id} /><SubmitButton size="sm">{status === "paused" ? "Resume" : "Activate"}</SubmitButton></ActionForm>
      ) : null}
      {status === "active" ? (
        <ActionForm action={pauseCouponAction} successMessage="Paused."><input type="hidden" name="id" value={id} /><SubmitButton size="sm" variant="outline">Pause</SubmitButton></ActionForm>
      ) : null}
    </div>
  );
}

export function VoidRedemptionButton({ id }: { id: string }) {
  return (
    <ActionForm action={voidRedemptionAction} confirm="Void this redemption? Use only for failed or abandoned payments." successMessage="Voided.">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="reason" value="staff void" />
      <SubmitButton size="sm" variant="outline">Void</SubmitButton>
    </ActionForm>
  );
}

export function ReferralActions({ id }: { id: string }) {
  return (
    <div className="space-y-2">
      <ActionForm action={releaseReferralAction} confirm="Release credits to both businesses now?" successMessage="Released.">
        <input type="hidden" name="id" value={id} /><SubmitButton size="sm">Release reward</SubmitButton>
      </ActionForm>
      <ActionForm action={rejectReferralAction} successMessage="Rejected. The referrer sees the reason.">
        <input type="hidden" name="id" value={id} />
        <label htmlFor={`rr-${id}`} className="block text-xs text-muted">Reason (shown to the referrer)</label>
        <div className="flex gap-2"><Input id={`rr-${id}`} name="reason" required maxLength={300} /><SubmitButton size="sm" variant="danger">Reject</SubmitButton></div>
      </ActionForm>
    </div>
  );
}
