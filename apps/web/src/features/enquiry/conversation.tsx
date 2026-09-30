import { Money, cn } from "@cnote/ui";
import type { ConversationView } from "@cnote/enquiry";
import { useLocale, useTranslations } from "next-intl";
import { formatDate, isLocale, type Locale } from "@/i18n/config";

type Item =
  | { kind: "message"; at: string; id: string; mine: boolean; body: string }
  | { kind: "quote"; at: string; id: string; quote: ConversationView["quotes"][number] };

const useAppLocale = (): Locale => {
  const l = useLocale();
  return isLocale(l) ? l : "en";
};
const stamp = (d: string, locale: Locale) => formatDate(d, locale, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Chronological thread of messages and quotes. Side-agnostic (takes the viewer's personId), so the
 * seller app can render the same component or build its own on top of getConversation().
 */
export function MessageThread({ conversation, myPersonId, counterpartyName }: { conversation: ConversationView; myPersonId: string; counterpartyName: string }) {
  const t = useTranslations("buyer");
  const locale = useAppLocale();
  const items: Item[] = [
    ...conversation.messages.map((m): Item => ({ kind: "message", at: m.createdAt, id: m.id, mine: m.senderPersonId === myPersonId, body: m.body })),
    ...conversation.quotes.map((q): Item => ({ kind: "quote", at: q.createdAt, id: q.id, quote: q })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (items.length === 0) return <p className="py-8 text-center text-sm text-muted">{t("noMessages", { name: counterpartyName })}</p>;
  return (
    <ol className="flex flex-col gap-3" aria-label={t("threadLabel")}>
      {items.map((it) =>
        it.kind === "message" ? (
          <li key={it.id} className={cn("flex", it.mine ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] rounded-2xl px-4 py-2 text-sm", it.mine ? "bg-brand-600 text-white" : "border border-line bg-surface text-ink")}>
              <p className="whitespace-pre-wrap break-words">{it.body}</p>
              <p className={cn("mt-1 text-[11px]", it.mine ? "text-white/80" : "text-muted")}>
                {it.mine ? t("you") : counterpartyName} · {stamp(it.at, locale)}
              </p>
            </div>
          </li>
        ) : (
          <li key={it.id}>
            <QuoteCard quote={it.quote} from={counterpartyName} at={it.at} />
          </li>
        ),
      )}
    </ol>
  );
}

export function QuoteCard({ quote, from, at }: { quote: ConversationView["quotes"][number]; from: string; at: string }) {
  const t = useTranslations("buyer");
  const locale = useAppLocale();
  const term = (group: "delivery" | "payment", key: string | null | undefined) => (key ? (t.has(`${group}.${key}`) ? t(`${group}.${key}`) : key) : null);
  return (
    <div className="rounded-card border border-accent-100 bg-accent-50 p-4 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent-700">{t("quoteFrom", { from })}</p>
      <p className="mt-1 text-lg">
        <Money paise={quote.pricePaise} unit={quote.unit} />
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ink">
        <dt className="text-muted">{t("quantity")}</dt>
        <dd>{quote.quantity} {quote.unit}</dd>
        <dt className="text-muted">{t("total")}</dt>
        <dd><Money paise={quote.pricePaise * quote.quantity} /></dd>
        {quote.leadTimeDays !== null ? (<><dt className="text-muted">{t("leadTime")}</dt><dd>{t("days", { count: quote.leadTimeDays })}</dd></>) : null}
        {quote.validUntil ? (<><dt className="text-muted">{t("validUntil")}</dt><dd>{quote.validUntil}</dd></>) : null}
        {quote.moq != null ? (<><dt className="text-muted">{t("minOrder")}</dt><dd>{quote.moq} {quote.moqUnit ?? quote.unit}</dd></>) : null}
        {quote.deliveryTerms ? (<><dt className="text-muted">{t("deliveryTerms")}</dt><dd>{[term("delivery", quote.deliveryTerms), quote.deliveryNote].filter(Boolean).join(" · ")}</dd></>) : null}
        {quote.deliveryChargePaise != null ? (<><dt className="text-muted">{t("deliveryCharge")}</dt><dd>{quote.deliveryChargePaise === 0 ? t("none") : <Money paise={quote.deliveryChargePaise} />}</dd></>) : null}
        {quote.paymentTerms ? (<><dt className="text-muted">{t("paymentTerms")}</dt><dd>{[term("payment", quote.paymentTerms), quote.paymentNote].filter(Boolean).join(" · ")}</dd></>) : null}
        {quote.gstIncluded != null ? (<><dt className="text-muted">{t("gst")}</dt><dd>{quote.gstIncluded ? t("gstIncluded") : t("gstExtra")}</dd></>) : null}
      </dl>
      {quote.notes ? <p className="mt-2 whitespace-pre-wrap text-ink">{quote.notes}</p> : null}
      <p className="mt-2 text-[11px] text-muted">{stamp(at, locale)}</p>
    </div>
  );
}
