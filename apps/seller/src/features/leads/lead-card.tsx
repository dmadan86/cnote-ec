"use client";
import Link from "next/link";
import { useActionState } from "react";
import { MapPin, MessageSquare, Phone } from "lucide-react";
import { Alert, Badge, Card, CardBody, IntentScore, TrustBadge, buttonClasses } from "@cnote/ui";
import type { LeadView } from "@cnote/enquiry";
import { SubmitButton } from "@/features/shell/form-bits";
import { formatDate } from "@/lib/format";
import { acceptLeadAction, declineLeadAction, reportBuyerProblemAction, type LeadResult } from "./actions";
import { Countdown } from "./countdown";

const DECLINE_REASONS = ["Not what I sell", "Quantity too small", "Outside my delivery area", "Budget does not match", "Too busy right now", "Other"];

const STATUS: Record<LeadView["status"], { tone: "neutral" | "success" | "warning" | "danger" | "brand"; label: string }> = {
  offered: { tone: "brand", label: "Waiting for you" },
  accepted: { tone: "success", label: "Accepted" },
  declined: { tone: "neutral", label: "Declined" },
  expired: { tone: "neutral", label: "Expired" },
  refunded: { tone: "warning", label: "Credit refunded" },
};

function errorOf(s: LeadResult | null) {
  return s && !s.ok ? s.error : null;
}

function OfferedActions({ lead, balance }: { lead: LeadView; balance: number | null }) {
  const [acc, accept] = useActionState<LeadResult | null, FormData>(acceptLeadAction, null);
  const [dec, decline] = useActionState<LeadResult | null, FormData>(declineLeadAction, null);
  const noCredits = balance !== null && balance <= 0;
  const err = errorOf(acc) ?? errorOf(dec);
  return (
    <div className="space-y-3">
      {noCredits ? (
        <Alert tone="warning">
          You have no lead credits left, so you cannot accept this lead. <Link href="/billing" className="font-medium underline">Get credits</Link>
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <form action={accept} className="flex-1 sm:flex-none">
          <input type="hidden" name="matchId" value={lead.matchId} />
          <SubmitButton size="lg" className="w-full sm:w-auto" disabled={noCredits} pendingText="Accepting…">
            Accept lead (uses 1 credit)
          </SubmitButton>
        </form>
        <details className="group flex-1 sm:flex-none">
          <summary className={buttonClasses("outline", "lg", "w-full cursor-pointer list-none sm:w-auto")}>Decline</summary>
          <form action={decline} className="mt-3 space-y-3 rounded-lg border border-line bg-canvas p-3">
            <input type="hidden" name="matchId" value={lead.matchId} />
            <label htmlFor={`reason-${lead.matchId}`} className="text-sm font-medium text-ink">
              Why are you declining? (helps us match better)
            </label>
            <select id={`reason-${lead.matchId}`} name="reason" defaultValue="" className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm">
              <option value="">Skip</option>
              {DECLINE_REASONS.map((r) => <option key={r}>{r}</option>)}
            </select>
            <SubmitButton variant="outline" pendingText="Declining…">Confirm decline, no credit used</SubmitButton>
          </form>
        </details>
      </div>
      <p className="text-xs text-muted">Nothing is charged until you accept. If you decline, the lead moves to the next seller.</p>
      {err ? <Alert tone="danger">{err}</Alert> : null}
    </div>
  );
}

function AcceptedPanel({ lead }: { lead: LeadView }) {
  const [rep, report] = useActionState<LeadResult | null, FormData>(reportBuyerProblemAction, null);
  return (
    <div className="space-y-3 rounded-lg border border-green-100 bg-green-50 p-4">
      <div>
        <p className="font-semibold text-ink">{lead.buyer.businessName}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-ink">
          {lead.buyer.city ? <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" aria-hidden />{lead.buyer.city}</span> : null}
          <TrustBadge tier={lead.buyer.verificationTier} badgeActive={lead.buyer.verificationTier >= 1} />
        </p>
        {lead.buyer.phone ? (
          <a href={`tel:${lead.buyer.phone}`} className="mt-2 inline-flex min-h-11 items-center gap-2 font-semibold text-brand-700 underline">
            <Phone className="size-4" aria-hidden /> {lead.buyer.phone}
          </a>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {lead.conversationId ? (
          <Link href={`/conversations/${lead.conversationId}`} className={buttonClasses("primary", "md", "min-h-11")}>
            <MessageSquare className="size-4" aria-hidden /> Open conversation
          </Link>
        ) : null}
      </div>
      {lead.reachabilityCheck ? <Alert tone="info">Checking with the buyer. We will decide on your refund within 24 hours.</Alert> : null}
      <details>
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-ink underline">Report unreachable or fake</summary>
        <form action={report} className="mt-2 space-y-3">
          <input type="hidden" name="matchId" value={lead.matchId} />
          <p className="text-sm text-muted">Tried to reach the buyer and could not, or the enquiry was not real? Tell us within 72 hours of accepting. We verify it and refund your credit automatically. No support ticket needed.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <SubmitButton name="kind" value="buyer_unreachable" variant="outline" pendingText="Sending…">Buyer unreachable</SubmitButton>
            <SubmitButton name="kind" value="buyer_fake" variant="outline" pendingText="Sending…">Enquiry looks fake</SubmitButton>
          </div>
          {rep?.ok ? <Alert tone="success">Thanks. We are checking this with the buyer and will decide on your refund within 24 hours.</Alert> : null}
          {errorOf(rep) ? <Alert tone="danger">{errorOf(rep)}</Alert> : null}
        </form>
      </details>
    </div>
  );
}

export function LeadCard({ lead, balance }: { lead: LeadView; balance: number | null }) {
  const e = lead.enquiry;
  const st = STATUS[lead.status];
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 text-base font-semibold text-ink">{e.title}</h2>
          <Badge tone={st.tone}>{st.label}</Badge>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">Quantity</dt>
            <dd className="font-medium text-ink">{e.quantity != null ? `${e.quantity} ${e.quantityUnit ?? ""}` : "Not specified"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Deliver to</dt>
            <dd className="font-medium text-ink">{e.deliveryCity ?? "Not specified"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Needed by</dt>
            <dd className="font-medium text-ink">{e.neededBy ? formatDate(e.neededBy) : "Flexible"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Category</dt>
            <dd className="font-medium text-ink">{e.category?.name ?? "Any"}</dd>
          </div>
        </dl>
        <p className="line-clamp-3 text-sm text-muted">{e.requirement}</p>

        <div className="flex flex-wrap items-center gap-2">
          {e.intentScore != null ? <IntentScore score={e.intentScore} /> : <Badge>Intent score pending</Badge>}
          <Badge tone="brand" title="Only this many sellers receive this lead">Rank {lead.rank} of {lead.of}</Badge>
        </div>
        {e.intentReasons.length ? (
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink">
            {e.intentReasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        ) : null}

        {lead.status === "offered" ? (
          <>
            <Countdown respondBy={lead.respondBy} />
            <OfferedActions lead={lead} balance={balance} />
          </>
        ) : null}
        {lead.status === "accepted" ? <AcceptedPanel lead={lead} /> : null}
        {lead.status === "refunded" ? <p className="text-sm text-muted">This lead was reported and your credit was refunded.</p> : null}
      </CardBody>
    </Card>
  );
}
