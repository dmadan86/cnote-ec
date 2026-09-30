import { useLocale, useTranslations } from "next-intl";
import { Badge, Money } from "@cnote/ui";
import type { NegotiationView } from "@cnote/a2a";
import { isLocale } from "@/i18n/config";
import { formatDate, formatDateTime } from "@/lib/format";

/**
 * Typed transcript: one row per protocol message (who, type, price per unit, quantity, unit, lead time, terms, validity).
 * Only the viewer's own limits exist in the view; the counterparty's floor/ceiling is never part of it.
 */
export function Transcript({ n }: { n: Pick<NegotiationView, "messages" | "buyer" | "seller"> }) {
  const t = useTranslations("a2a");
  const loc = useLocale();
  const locale = isLocale(loc) ? loc : "en";
  if (n.messages.length === 0) return <p className="text-sm text-muted">{t("transcript.empty")}</p>;
  const dash = <span aria-label={t("transcript.none")}>-</span>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-left text-sm">
        <caption className="sr-only">{t("transcript.caption")}</caption>
        <thead>
          <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
            {(["round", "who", "type", "price", "qty", "lead", "terms", "valid"] as const).map((c) => <th key={c} scope="col" className="px-2 py-2 font-medium">{t(`transcript.col.${c}`)}</th>)}
          </tr>
        </thead>
        <tbody>
          {n.messages.map((m) => {
            const o = m.offer;
            const who = m.mine ? t("transcript.you") : (m.side === "buyer" ? n.buyer.name : n.seller.name);
            return (
              <tr key={m.seq} className="border-b border-line align-top">
                <td className="px-2 py-2 tabular-nums">{m.seq}</td>
                <td className="px-2 py-2">
                  <span className="font-medium text-ink">{who}</span>{" "}
                  <Badge tone="neutral">{t(`transcript.actor.${m.actor}`)}</Badge>
                  <div className="text-xs text-muted">{formatDateTime(m.createdAt, locale)}</div>
                </td>
                <td className="px-2 py-2"><Badge tone={m.type === "accept" ? "success" : m.type === "reject" || m.type === "withdraw" ? "danger" : "brand"}>{t(`transcript.type.${m.type}`)}</Badge></td>
                <td className="px-2 py-2">{o ? <Money paise={o.pricePaise} unit={o.unit} /> : dash}</td>
                <td className="px-2 py-2 tabular-nums">{o ? `${o.quantity.toLocaleString("en-IN")} ${o.unit}` : dash}</td>
                <td className="px-2 py-2">{o ? t("transcript.days", { n: o.leadTimeDays }) : dash}</td>
                <td className="px-2 py-2">
                  {o ? (
                    <>
                      <div>{o.deliveryTerms ?? dash}</div>
                      <div className="text-xs text-muted">{o.paymentTerms ?? dash}</div>
                    </>
                  ) : dash}
                </td>
                <td className="px-2 py-2">{o ? formatDate(o.validUntil, locale) : dash}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
