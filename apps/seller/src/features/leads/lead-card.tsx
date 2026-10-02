"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { MapPin, MessageSquare, Phone } from "lucide-react";
import { Alert, Badge, Card, CardBody, IntentScore, TrustBadge, buttonClasses } from "@cnote/ui";
import type { LeadView } from "@cnote/enquiry";
import { SubmitButton } from "@/features/shell/form-bits";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { acceptLeadAction, declineLeadAction, reportBuyerProblemAction, type LeadResult } from "./actions";
import { Countdown } from "./countdown";

// The English value is what the server validates and stores (ADR-002 decline reasons); only the label is translated.
const DECLINE_REASONS = [
  { value: "Not what I sell", key: "notMine" },
  { value: "Quantity too small", key: "smallQty" },
  { value: "Outside my delivery area", key: "area" },
  { value: "Budget does not match", key: "budget" },
  { value: "Too busy right now", key: "busy" },
  { value: "Other", key: "other" },
] as const;

const STATUS: Record<LeadView["status"], { tone: "neutral" | "success" | "warning" | "danger" | "brand" }> = {
  offered: { tone: "brand" },
  accepted: { tone: "success" },
  declined: { tone: "neutral" },
  expired: { tone: "neutral" },
  refunded: { tone: "warning" },
};

function errorOf(s: LeadResult | null) {
  return s && !s.ok ? s.error : null;
}

function OfferedActions({ lead, balance }: { lead: LeadView; balance: number | null }) {
  const t = useTranslations("leads");
  const [acc, accept] = useActionState<LeadResult | null, FormData>(acceptLeadAction, null);
  const [dec, decline] = useActionState<LeadResult | null, FormData>(declineLeadAction, null);
  const noCredits = balance !== null && balance <= 0;
  const err = errorOf(acc) ?? errorOf(dec);
  return (
    <div className="space-y-3">
      {noCredits ? (
        <Alert tone="warning">
          {t.rich("noCredits", { link: (c) => <Link href="/billing" className="font-medium underline">{c}</Link> })}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <form action={accept} className="flex-1 sm:flex-none">
          <input type="hidden" name="matchId" value={lead.matchId} />
          <SubmitButton size="lg" className="w-full sm:w-auto" disabled={noCredits} pendingText={t("accepting")}>
            {t("accept")}
          </SubmitButton>
        </form>
        <details className="group flex-1 sm:flex-none">
          <summary className={buttonClasses("outline", "lg", "w-full cursor-pointer list-none sm:w-auto")}>{t("decline")}</summary>
          <form action={decline} className="mt-3 space-y-3 rounded-lg border border-line bg-canvas p-3">
            <input type="hidden" name="matchId" value={lead.matchId} />
            <label htmlFor={`reason-${lead.matchId}`} className="text-sm font-medium text-ink">
              {t("declineWhy")}
            </label>
            <select id={`reason-${lead.matchId}`} name="reason" defaultValue="" className="h-11 w-full rounded-lg border border-line bg-surface px-3 text-sm">
              <option value="">{t("skip")}</option>
              {DECLINE_REASONS.map((r) => <option key={r.value} value={r.value}>{t(`declineReasons.${r.key}`)}</option>)}
            </select>
            <SubmitButton variant="outline" pendingText={t("declining")}>{t("confirmDecline")}</SubmitButton>
          </form>
        </details>
      </div>
      <p className="text-xs text-muted">{t("nothingCharged")}</p>
      {err ? <Alert tone="danger">{err}</Alert> : null}
    </div>
  );
}

function AcceptedPanel({ lead }: { lead: LeadView }) {
  const t = useTranslations("leads");
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
            <MessageSquare className="size-4" aria-hidden /> {t("openConversation")}
          </Link>
        ) : null}
      </div>
      {lead.reachabilityCheck ? <Alert tone="info">{t("checkingBuyer")}</Alert> : null}
      <details>
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium text-ink underline">{t("reportSummary")}</summary>
        <form action={report} className="mt-2 space-y-3">
          <input type="hidden" name="matchId" value={lead.matchId} />
          <p className="text-sm text-muted">{t("reportHelp")}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <SubmitButton name="kind" value="buyer_unreachable" variant="outline" pendingText={t("sending")}>{t("buyerUnreachable")}</SubmitButton>
            <SubmitButton name="kind" value="buyer_fake" variant="outline" pendingText={t("sending")}>{t("enquiryFake")}</SubmitButton>
          </div>
          {rep?.ok ? <Alert tone="success">{t("reportThanks")}</Alert> : null}
          {errorOf(rep) ? <Alert tone="danger">{errorOf(rep)}</Alert> : null}
        </form>
      </details>
    </div>
  );
}

export function LeadCard({ lead, balance }: { lead: LeadView; balance: number | null }) {
  const t = useTranslations("leads");
  const loc = useLocale();
  const locale = isLocale(loc) ? loc : "en";
  const e = lead.enquiry;
  const tr = useTranslations("rfqLead");
  const st = STATUS[lead.status];
  const rupees = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const budget = [e.budgetMinPaise ? rupees(e.budgetMinPaise) : null, e.budgetMaxPaise ? rupees(e.budgetMaxPaise) : null].filter(Boolean).join(" – ");
  const deadlinePassed = e.expiresAt ? new Date(e.expiresAt).getTime() < Date.now() : false;
  const hasRfqDetails = !!(e.targetPricePaise || budget || e.deliveryPincode || e.expiresAt || e.minSellerTier || e.attachments.length);
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="min-w-0 text-base font-semibold text-ink">{e.title}</h2>
          <Badge tone={st.tone}>{t(`status.${lead.status}`)}</Badge>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted">{t("quantity")}</dt>
            <dd className="font-medium text-ink">{e.quantity != null ? `${e.quantity} ${e.quantityUnit ?? ""}` : t("notSpecified")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t("deliverTo")}</dt>
            <dd className="font-medium text-ink">{e.deliveryCity ?? t("notSpecified")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t("neededBy")}</dt>
            <dd className="font-medium text-ink">{e.neededBy ? formatDate(e.neededBy, locale) : t("flexible")}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">{t("category")}</dt>
            <dd className="font-medium text-ink">{e.category?.name ?? t("any")}</dd>
          </div>
        </dl>
        {hasRfqDetails ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4" data-testid="rfq-details">
            {e.targetPricePaise ? (
              <div>
                <dt className="text-xs text-muted">{tr("targetPrice")}</dt>
                <dd className="font-medium text-ink">{rupees(e.targetPricePaise)}</dd>
              </div>
            ) : null}
            {budget ? (
              <div>
                <dt className="text-xs text-muted">{tr("budget")}</dt>
                <dd className="font-medium text-ink">{budget}</dd>
              </div>
            ) : null}
            {e.deliveryPincode ? (
              <div>
                <dt className="text-xs text-muted">{tr("pincode")}</dt>
                <dd className="font-medium text-ink">{e.deliveryPincode}</dd>
              </div>
            ) : null}
            {e.expiresAt ? (
              <div>
                <dt className="text-xs text-muted">{tr("quoteDeadline")}</dt>
                <dd className="font-medium text-ink">{deadlinePassed ? tr("deadlinePassed") : formatDate(e.expiresAt, locale)}</dd>
              </div>
            ) : null}
            {e.minSellerTier ? (
              <div>
                <dt className="text-xs text-muted">{tr("preferredTier")}</dt>
                <dd className="font-medium text-ink">{tr("tierPlus", { tier: e.minSellerTier })}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}
        {e.attachments.length ? (
          <div className="text-sm">
            <p className="text-xs text-muted">{tr("attachments")}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {e.attachments.map((a) => (
                <li key={a.id}>
                  <a href={`/api/rfq-attachments/${a.id}`} className="inline-flex min-h-11 items-center break-all font-medium text-brand-700 underline" download>
                    {tr("download", { name: a.fileName })}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="line-clamp-3 text-sm text-muted">{e.requirement}</p>

        <div className="flex flex-wrap items-center gap-2">
          {e.intentScore != null ? <IntentScore score={e.intentScore} /> : <Badge>{t("intentPending")}</Badge>}
          <Badge tone="brand" title={t("rankTitle")}>{t("rank", { rank: lead.rank, total: lead.of })}</Badge>
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
        {lead.status === "refunded" ? <p className="text-sm text-muted">{t("refundedNote")}</p> : null}
      </CardBody>
    </Card>
  );
}
