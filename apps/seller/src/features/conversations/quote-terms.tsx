import { getTranslations } from "next-intl/server";
import { Money } from "@cnote/ui";
import type { QuoteView } from "@cnote/enquiry";

/** Structured terms of a sent quote (renders nothing for old quotes that have none). */
export async function QuoteTerms({ q }: { q: QuoteView }) {
  const t = await getTranslations("leads.conversation");
  const rows: [string, React.ReactNode][] = [];
  if (q.moq != null) rows.push([t("moq"), `${q.moq} ${q.moqUnit ?? q.unit}`]);
  if (q.deliveryTerms) rows.push([t("deliveryTerms"), [t(`delivery_${q.deliveryTerms}`), q.deliveryNote].filter(Boolean).join(" · ")]);
  if (q.deliveryChargePaise != null) rows.push([t("deliveryCharge"), <Money key="c" paise={q.deliveryChargePaise} />]);
  if (q.paymentTerms) rows.push([t("paymentTerms"), [t(`payment_${q.paymentTerms}`), q.paymentNote].filter(Boolean).join(" · ")]);
  if (q.gstIncluded != null) rows.push([t("gst"), q.gstIncluded ? t("gstIncluded") : t("gstExtra")]);
  if (rows.length === 0) return null;
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted">{k}</dt><dd>{v}</dd></div>))}
    </dl>
  );
}
