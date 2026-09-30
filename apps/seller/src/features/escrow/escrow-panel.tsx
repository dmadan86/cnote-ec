import { getLocale, getTranslations } from "next-intl/server";
import { getEscrowForOrder, type EscrowView } from "@cnote/escrow";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Money, type BadgeTone } from "@cnote/ui";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { el } from "@/features/billing/rich-value";

const TONE: Record<string, BadgeTone> = { created: "neutral", awaiting_funding: "warning", funded: "brand", accepted: "success", released: "success", refunded: "neutral", cancelled: "neutral" };
const STEPS = ["funded", "confirmed", "dispatched", "delivered", "accepted"];

/** Seller view of an order's escrow (ADR-012): milestone status, fee disclosure and payout state. Read-only. */
export async function EscrowPanel({ actor, orderId }: { actor: { personId: string; businessId: string }; orderId: string }) {
  const res = await load(() => getEscrowForOrder(actor, orderId));
  if (!res.ok || !res.data) return null;
  const t = await getTranslations("escrow");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const e: EscrowView = res.data;
  const final = e.milestones.find((m) => m.milestone === "released" || m.milestone === "refunded")?.milestone;
  const steps = final ? [...STEPS, final] : STEPS;
  const at = (m: string) => e.milestones.find((x) => x.milestone === m)?.at;
  const held = e.status === "funded" || e.status === "accepted";
  return (
    <section aria-labelledby="escrow-heading">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle id="escrow-heading">{t("title")}</CardTitle>
          <Badge tone={TONE[e.status] ?? "neutral"}><span className="sr-only">{t("statusSr")}</span>{t.has(`status.${e.status}`) ? t(`status.${e.status}`) : e.status}</Badge>
        </CardHeader>
        <CardBody className="space-y-4 text-sm">
          {e.frozen ? <Alert tone="warning">{t("frozen")}</Alert> : null}
          {held ? <p>{e.autoReleaseAt && !e.frozen ? t("heldAuto", { date: formatDateTime(e.autoReleaseAt, locale) }) : t("heldDefault")}</p> : null}
          {e.status === "awaiting_funding" ? <p>{t("awaitingFunding")}</p> : null}
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Row k={t("orderValue")} v={<Money paise={e.amountPaise} />} />
            <Row k={t("fee")} v={t.rich("feeValue", { fee: el(<Money paise={e.feePaise} />), gst: el(<Money paise={e.feeGstPaise} />) })} />
            <Row k={t("youReceive")} v={<Money paise={e.sellerNetPaise} />} />
            <Row k={t("payout")} v={e.payout ? (() => { const s = t(e.payout.status === "settled" ? "payoutSettled" : e.payout.status === "failed" ? "payoutFailed" : "payoutPending"); return e.payout.settledAt ? t("payoutWithDate", { status: s, date: formatDateTime(e.payout.settledAt, locale) }) : s; })() : t("payoutNone")} />
          </dl>
          <div>
            <h3 className="font-semibold text-ink">{t("progress")}</h3>
            <ol className="mt-2 space-y-2">
              {steps.map((m) => (
                <li key={m} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0">
                  <span className={at(m) ? "font-medium text-ink" : "text-muted"}>{t(`step.${m}`)}</span>
                  <span className="text-muted">{at(m) ? t("done", { date: formatDateTime(at(m)!, locale) }) : t("pending")}</span>
                </li>
              ))}
            </ol>
          </div>
        </CardBody>
      </Card>
    </section>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="text-ink">{v}</dd>
    </div>
  );
}
