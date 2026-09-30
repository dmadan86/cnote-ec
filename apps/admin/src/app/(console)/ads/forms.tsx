"use client";
import { useState } from "react";
import { Field, Input, Select } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import {
  creditWalletAction, decideCampaignAction, invalidateClicksAction, killSwitchAction, reviewItemAction, setConfigAction, setRateCardAction, suspendCampaignAction, unsuspendCampaignAction,
} from "./actions";

const REASONS: [string, string][] = [
  ["irrelevant_keyword", "Irrelevant keyword"], ["trademark", "Trademark"], ["competitor_brand", "Competitor brand"], ["prohibited_category", "Prohibited category"],
  ["misleading_listing", "Misleading listing"], ["low_quality_listing", "Low quality listing"], ["other", "Other"],
];

function ReasonSelect({ id }: { id: string }) {
  return (
    <Select id={id} name="reasonCode" defaultValue="" aria-label="Reason code (required to reject)" className="h-9 w-48 text-xs">
      <option value="">Reason (to reject)</option>
      {REASONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </Select>
  );
}

/** Per listing / keyword / group decision, so one bad keyword does not sink a campaign. */
export function ItemReviewForm({ campaignId, subjectType, subjectId }: { campaignId: string; subjectType: "listing" | "keyword" | "ad_group"; subjectId: string }) {
  return (
    <ActionForm action={reviewItemAction} successMessage="Saved.">
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="subjectType" value={subjectType} />
      <input type="hidden" name="subjectId" value={subjectId} />
      <div className="flex flex-wrap items-center gap-2">
        <ReasonSelect id={`r-${subjectId}`} />
        <SubmitButton size="sm" name="decision" value="approved">Approve</SubmitButton>
        <SubmitButton size="sm" variant="danger" name="decision" value="rejected">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function DecideCampaignForm({ campaignId }: { campaignId: string }) {
  return (
    <ActionForm action={decideCampaignAction} successMessage="Decision recorded. The seller is notified.">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="flex flex-wrap items-end gap-2">
        <div><label htmlFor="note" className="block text-xs text-muted">Note to the seller (shown when rejecting)</label><Input id="note" name="note" maxLength={300} className="w-80" /></div>
        <ReasonSelect id="campaign-reason" />
        <SubmitButton name="decision" value="approved">Approve campaign</SubmitButton>
        <SubmitButton variant="danger" name="decision" value="rejected">Reject campaign</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function SuspendForm({ campaignId }: { campaignId: string }) {
  return (
    <ActionForm action={suspendCampaignAction} confirm="Suspend this campaign now? It stops serving immediately." successMessage="Suspended.">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="flex items-end gap-2">
        <div><label htmlFor={`sus-${campaignId}`} className="block text-xs text-muted">Reason (the seller sees it)</label><Input id={`sus-${campaignId}`} name="reason" required maxLength={300} /></div>
        <SubmitButton size="sm" variant="danger">Suspend</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function UnsuspendForm({ campaignId }: { campaignId: string }) {
  return (
    <ActionForm action={unsuspendCampaignAction} confirm="Lift the suspension? It returns to approved and can serve again." successMessage="Restored.">
      <input type="hidden" name="campaignId" value={campaignId} />
      <SubmitButton size="sm" variant="outline">Lift suspension</SubmitButton>
    </ActionForm>
  );
}

export function KillSwitchForm({ scope, on }: { scope: string; on: boolean }) {
  return (
    <ActionForm action={killSwitchAction} confirm={on ? `Switch ${scope} ads back on?` : `Switch OFF ${scope} ads immediately? No sponsored slot will be served.`} successMessage="Updated.">
      <input type="hidden" name="scope" value={scope} />
      <input type="hidden" name="state" value={on ? "off" : "on"} />
      <SubmitButton size="sm" variant={on ? "outline" : "danger"}>{on ? "Switch back on" : "Kill"}</SubmitButton>
    </ActionForm>
  );
}

export function InvalidateClicksForm({ campaignId, clicks }: { campaignId: string; clicks: { id: string; listingId: string; validity: string; invalidReason: string | null; chargedPaise: number; userAgentClass: string; settled: boolean; createdAt: string }[] }) {
  return (
    <ActionForm action={invalidateClicksAction} confirm="Invalidate the selected clicks? Settled charges are refunded to the seller's ad wallet automatically." successMessage="Invalidated and refunded where charged.">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="bg-canvas text-xs uppercase text-muted"><tr><th className="p-2"><span className="sr-only">Select</span></th><th className="p-2">When</th><th className="p-2">Status</th><th className="p-2">Reason</th><th className="p-2">Agent</th><th className="p-2 text-right">Charge</th><th className="p-2">Settled</th></tr></thead>
          <tbody>
            {clicks.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="p-2"><input type="checkbox" name="clickId" value={c.id} aria-label={`Select click ${c.id.slice(0, 8)}`} disabled={c.validity === "invalid"} className="size-4" /></td>
                <td className="whitespace-nowrap p-2 text-xs">{new Date(c.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</td>
                <td className="p-2">{c.validity}</td>
                <td className="p-2 text-xs">{c.invalidReason ?? ""}</td>
                <td className="p-2 text-xs">{c.userAgentClass}</td>
                <td className="p-2 text-right">₹{(c.chargedPaise / 100).toFixed(2)}</td>
                <td className="p-2 text-xs">{c.settled ? "yes" : "no"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex items-end gap-2">
        <div><label htmlFor="inv-reason" className="block text-xs text-muted">Reason code</label><Input id="inv-reason" name="reason" defaultValue="staff_review" maxLength={60} /></div>
        <SubmitButton variant="danger">Invalidate selected</SubmitButton>
      </div>
    </ActionForm>
  );
}

const CONFIG_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: "trustFloor", label: "Trust floor", hint: "Minimum trust score to advertise (never below 50)" },
  { key: "minVerificationTier", label: "Minimum verification tier" },
  { key: "minRelevance", label: "Minimum relevance (0-1)" },
  { key: "minOrganicForAds", label: "Minimum organic results for any ad" },
  { key: "maxAdShare", label: "Max share of cards that are ads (0-0.5)" },
  { key: "maxSearchSlots", label: "Max slots on search/category" },
  { key: "perOrganicResults", label: "One ad per N organic results" },
  { key: "maxProductSlots", label: "Max slots on product page" },
  { key: "frequencyCap", label: "Frequency cap per visitor/listing/day" },
  { key: "attributionWindowDays", label: "Attribution window (days)" },
  { key: "invalidClickRescoreHours", label: "Invalid-click re-score window (hours)" },
  { key: "clickBurstPerNetHour", label: "Clicks per network per hour before pending" },
  { key: "netDailyCap", label: "Clicks per network per day (re-score)" },
  { key: "visitorDailyCap", label: "Clicks per visitor per listing per day (re-score)" },
  { key: "revenueCapPct", label: "Ad revenue cap (% of trailing 90 days)", hint: "Monitoring alert only" },
  { key: "walletLowDays", label: "Wallet-low alert (days of spend)" },
  { key: "walletLowFloorPaise", label: "Wallet-low floor (paise)" },
  { key: "minDailyBudgetPaise", label: "Minimum daily budget (paise)" },
  { key: "paceMultiplier", label: "Pacing multiplier (>=1)" },
];

export function ConfigForm({ values }: { values: Record<string, number> }) {
  return (
    <ActionForm action={setConfigAction} successMessage="Saved. Takes effect within a minute, no deploy." className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CONFIG_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`cfg-${f.key}`} hint={f.hint}>
            <Input id={`cfg-${f.key}`} name={f.key} type="number" step="any" defaultValue={values[f.key]} />
          </Field>
        ))}
      </div>
      <SubmitButton>Save settings</SubmitButton>
    </ActionForm>
  );
}

export function RateCardForm({ categories }: { categories: { id: string; name: string }[] }) {
  const [max, setMax] = useState("");
  return (
    <ActionForm action={setRateCardAction} successMessage="Rate saved as a new version." className="grid gap-3 sm:grid-cols-3">
      <Field label="Category" htmlFor="rc-cat" hint="Empty = platform default. Applies to the whole subtree."><Select id="rc-cat" name="categoryId" defaultValue=""><option value="">All categories (default)</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      <Field label="Placement" htmlFor="rc-surface"><Select id="rc-surface" name="surface" defaultValue="search"><option value="search">Search results</option><option value="category">Category pages</option><option value="product_similar">Product page rail</option></Select></Field>
      <Field label="Price per click (₹)" htmlFor="rc-cpc"><Input id="rc-cpc" name="cpcRupees" type="number" step="0.01" min="1" required /></Field>
      <Field label="Max price per click (₹, optional)" htmlFor="rc-max"><Input id="rc-max" name="maxCpcRupees" type="number" step="0.01" min="1" value={max} onChange={(e) => setMax(e.target.value)} /></Field>
      <Field label="Effective from (optional)" htmlFor="rc-from" hint="Empty = now. A future date shows on the public card only from then."><Input id="rc-from" name="effectiveFrom" type="date" /></Field>
      <div className="flex items-end"><SubmitButton>Publish rate</SubmitButton></div>
    </ActionForm>
  );
}

export function CreditWalletForm() {
  return (
    <ActionForm action={creditWalletAction} confirm="Credit this ad wallet? This is an audited ledger entry and cannot be edited." successMessage="Wallet credited." className="grid gap-3 sm:grid-cols-4">
      <Field label="Business id" htmlFor="cw-biz"><Input id="cw-biz" name="businessId" required /></Field>
      <Field label="Amount (₹, ex-GST)" htmlFor="cw-amt"><Input id="cw-amt" name="rupees" type="number" step="0.01" min="1" required /></Field>
      <Field label="Bank reference" htmlFor="cw-ref" hint="Repeating a reference never credits twice."><Input id="cw-ref" name="bankRef" required /></Field>
      <div className="flex items-end"><SubmitButton>Credit wallet</SubmitButton></div>
    </ActionForm>
  );
}
