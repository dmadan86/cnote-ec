import { getEscrowForOrder, getEscrowOffer, type EscrowView } from "@cnote/escrow";
import type { OrderView } from "@cnote/enquiry";
import { Alert, Badge, Card, CardBody, CardTitle, type BadgeTone } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import { type Locale } from "@/i18n/config";
import { EscrowActions } from "./escrow-actions";

const TONE: Record<string, BadgeTone> = { created: "neutral", awaiting_funding: "warning", funded: "brand", accepted: "success", released: "success", refunded: "brand", cancelled: "neutral" };
const STEPS = ["funded", "confirmed", "dispatched", "delivered", "accepted"] as const;

const inr = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: paise % 100 === 0 ? 0 : 2 }).format(paise / 100);

/**
 * Buyer-facing escrow panel for one order (ADR-012). Hidden entirely while ESCROW_ENABLED is off and no escrow exists.
 * Semantics for WCAG 2.2 AA: a labelled section, an ordered list for the timeline where done/pending is stated in text
 * (never by colour alone), and polite live-region errors from the actions form.
 */
export async function EscrowPanel({ actor, order, locale = "en" }: { actor: { personId: string; businessId: string }; order: OrderView; locale?: Locale }) {
  const [escrow, offer, t] = await Promise.all([
    getEscrowForOrder(actor, order.id),
    getEscrowOffer(actor, order),
    getTranslations({ locale, namespace: "escrow" }),
  ]);
  if (!escrow && !offer.eligible) return null;
  const dt = new Intl.DateTimeFormat(`${locale}-IN`, { dateStyle: "medium", timeZone: "Asia/Kolkata" });
  const labels = { start: t("startEscrow"), payMock: t("payMock"), payMockHelp: t("payMockHelp"), payLink: t("payLink"), accept: t("accept"), acceptHelp: t("acceptHelp"), error: t("errorGeneric") };
  const quote = escrow ? { amountPaise: escrow.amountPaise, feeBps: offer.quote?.feeBps ?? 150, capPaise: offer.quote?.capPaise ?? 500_000 } : offer.quote;
  const fee = quote ? t("feeDisclosure", { amount: inr(quote.amountPaise), percent: String((quote.feeBps ?? 150) / 100), cap: inr(quote.capPaise ?? 500_000) }) : null;
  return (
    <section aria-labelledby="escrow-heading">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle id="escrow-heading" className="text-lg">{t("heading")}</CardTitle>
            {escrow ? <Badge tone={TONE[escrow.status] ?? "neutral"}><span className="sr-only">{t("statusLabel")}: </span>{t(`status.${escrow.status}`)}</Badge> : null}
          </div>
          <p className="text-sm text-ink">{t("intro")}</p>
          {!escrow ? <p className="text-sm text-muted">{t("optionalNote")}</p> : null}
          {!escrow && offer.nudge ? <Alert tone="info">{t("nudge")}</Alert> : null}
          {fee ? <p className="text-sm text-ink">{fee}</p> : null}
          {escrow?.frozen ? <Alert tone="warning">{t("frozen")}</Alert> : null}
          {escrow ? <Body escrow={escrow} t={t} dt={dt} /> : null}
          <EscrowActions
            orderId={order.id}
            labels={labels}
            canStart={!escrow && offer.eligible}
            canPayMock={!!escrow?.actions.fund && escrow.partner === "mock" && escrow.status === "awaiting_funding"}
            payLinkHref={escrow?.actions.fund && escrow.partner !== "mock" && escrow.checkoutUrl ? escrow.checkoutUrl : null}
            canAccept={!!escrow?.actions.accept}
          />
          {escrow?.status === "funded" && !escrow.actions.accept && !escrow.frozen && escrow.role === "buyer" ? <p className="text-sm text-muted">{t("acceptWaiting")}</p> : null}
        </CardBody>
      </Card>
    </section>
  );
}

type T = Awaited<ReturnType<typeof getTranslations>>;

function Body({ escrow, t, dt }: { escrow: EscrowView; t: T; dt: Intl.DateTimeFormat }) {
  const final = escrow.milestones.find((m) => m.milestone === "released" || m.milestone === "refunded")?.milestone;
  const steps: string[] = final ? [...STEPS, final] : [...STEPS];
  const at = (m: string) => escrow.milestones.find((x) => x.milestone === m)?.at;
  const held = escrow.status === "funded" || escrow.status === "accepted";
  return (
    <>
      {held ? <p className="text-sm text-ink"><span className="font-medium">{t("heldLabel")}:</span> {inr(escrow.amountPaise - escrow.releasedPaise - escrow.refundedPaise)}. {t("fundedNote")}</p> : null}
      {escrow.status === "awaiting_funding" && escrow.fundingExpiresAt ? <p className="text-sm text-muted">{t("expires", { date: dt.format(new Date(escrow.fundingExpiresAt)) })}</p> : null}
      {held && escrow.autoReleaseAt && !escrow.frozen ? <p className="text-sm text-muted">{t("autoRelease", { date: dt.format(new Date(escrow.autoReleaseAt)) })}</p> : null}
      {escrow.status === "released" ? <p className="text-sm text-ink">{t("releasedNote")}</p> : null}
      {escrow.status === "refunded" ? <p className="text-sm text-ink">{t("refundedNote")}</p> : null}
      {escrow.status === "cancelled" ? <p className="text-sm text-ink">{t("cancelledNote")}</p> : null}
      <div>
        <h3 className="text-sm font-semibold text-ink">{t("milestonesHeading")}</h3>
        <ol className="mt-2 flex flex-col gap-2 text-sm">
          {steps.map((m) => {
            const when = at(m);
            return (
              <li key={m} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0">
                <span className={when ? "font-medium text-ink" : "text-muted"}>{t(`milestone.${m}`)}</span>
                <span className="text-muted">{when ? `${t("milestoneDone")}, ${dt.format(new Date(when))}` : t("milestonePending")}</span>
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}
