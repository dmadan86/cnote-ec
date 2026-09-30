import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { actorOf } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { isLocale } from "@/i18n/config";
import { formatDateTime, formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { DealReportForm, MessageForm, QuoteForm } from "@/features/conversations/forms";
import { QuoteAssistPanel } from "@/features/negotiation/quote-assist-panel";
import { el } from "@/features/billing/rich-value";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("leads.conversation"))("metaTitle") };
}

export default async function ConversationPage({ params }: PageProps<"/conversations/[id]">) {
  const { id } = await params;
  const session = await requireSeller(`/conversations/${id}`);
  const t = await getTranslations("leads.conversation");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const res = await load(() => enquiry.getConversation(actorOf(session), id));

  const back = (
    <Link href="/leads" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700">
      <ArrowLeft className="size-4" aria-hidden /> {t("backToLeads")}
    </Link>
  );
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const c = res.data;
  if (!c) return <div className="space-y-4">{back}<Alert tone="warning">{t("notFound")}</Alert></div>;

  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={c.enquiryTitle} description={t("withBuyer", { name: c.buyer.name })} />

      <Card>
        <CardHeader><CardTitle>{t("messagesTitle")}</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          {c.messages.length === 0 ? <p className="text-sm text-muted">{t("noMessages")}</p> : (
            <ol className="space-y-3" aria-label={t("messagesLabel")}>
              {c.messages.map((m) => {
                const mine = m.senderPersonId === session.personId;
                return (
                  <li key={m.id} className={mine ? "flex justify-end" : "flex justify-start"}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${mine ? "bg-brand-600 text-white" : "bg-canvas text-ink"}`}>
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <p className={`mt-1 text-[11px] ${mine ? "text-brand-100" : "text-muted"}`}>{t("messageMeta", { who: mine ? t("you") : c.buyer.name, when: formatDateTime(m.createdAt, locale) })}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <MessageForm conversationId={c.id} />
        </CardBody>
      </Card>

      <QuoteAssistPanel matchId={c.matchId} conversationId={c.id} sellerBusinessId={session.business.id} />

      <Card>
        <CardHeader><CardTitle>{t("sendQuoteTitle")}</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          {c.quotes.length ? (
            <ul className="space-y-2" aria-label={t("quotesSent")}>
              {c.quotes.map((q) => (
                <li key={q.id} className="rounded-lg border border-line p-3 text-sm">
                  {t.rich("quoteFor", { price: el(<Money paise={q.pricePaise} unit={q.unit} />), quantity: q.quantity, unit: q.unit })}
                  {q.leadTimeDays != null ? `, ${t("quoteDelivery", { days: q.leadTimeDays })}` : ""}
                  {q.validUntil ? `, ${t("quoteValid", { date: formatDate(q.validUntil, locale) })}` : ""}
                  {q.notes ? <p className="mt-1 text-muted">{q.notes}</p> : null}
                  <p className="mt-1 text-xs text-muted">{t("quoteSentAt", { when: formatDateTime(q.createdAt, locale) })}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <QuoteForm conversationId={c.id} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t("dealTitle")}</CardTitle></CardHeader>
        <CardBody>
          <p className="mb-3 text-sm text-muted">{t("dealHelp")}</p>
          <DealReportForm conversationId={c.id} matchId={c.matchId} current={c.dealReported} />
        </CardBody>
      </Card>
    </div>
  );
}
