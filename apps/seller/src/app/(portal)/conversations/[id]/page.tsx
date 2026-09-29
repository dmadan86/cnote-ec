import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { actorOf } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardHeader, CardTitle, Money, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDateTime, formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { enquiry } from "@/lib/services";
import { DealReportForm, MessageForm, QuoteForm } from "@/features/conversations/forms";

export const metadata: Metadata = { title: "Conversation" };

export default async function ConversationPage({ params }: PageProps<"/conversations/[id]">) {
  const { id } = await params;
  const session = await requireSeller(`/conversations/${id}`);
  const res = await load(() => enquiry.getConversation(actorOf(session), id));

  const back = (
    <Link href="/leads" className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-brand-700">
      <ArrowLeft className="size-4" aria-hidden /> Back to leads
    </Link>
  );
  if (!res.ok) return <div className="space-y-4">{back}<Alert tone="danger">{res.error}</Alert></div>;
  const c = res.data;
  if (!c) return <div className="space-y-4">{back}<Alert tone="warning">We could not find this conversation, or it belongs to another business.</Alert></div>;

  return (
    <div className="space-y-6">
      {back}
      <PageHeader title={c.enquiryTitle} description={`With ${c.buyer.name}`} />

      <Card>
        <CardHeader><CardTitle>Messages</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          {c.messages.length === 0 ? <p className="text-sm text-muted">No messages yet. Say hello and confirm the requirement.</p> : (
            <ol className="space-y-3" aria-label="Messages">
              {c.messages.map((m) => {
                const mine = m.senderPersonId === session.personId;
                return (
                  <li key={m.id} className={mine ? "flex justify-end" : "flex justify-start"}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${mine ? "bg-brand-600 text-white" : "bg-canvas text-ink"}`}>
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <p className={`mt-1 text-[11px] ${mine ? "text-brand-100" : "text-muted"}`}>{mine ? "You" : c.buyer.name} · {formatDateTime(m.createdAt)}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          <MessageForm conversationId={c.id} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Send a quote</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          {c.quotes.length ? (
            <ul className="space-y-2" aria-label="Quotes sent">
              {c.quotes.map((q) => (
                <li key={q.id} className="rounded-lg border border-line p-3 text-sm">
                  <Money paise={q.pricePaise} unit={q.unit} /> for {q.quantity} {q.unit}
                  {q.leadTimeDays != null ? `, delivery in ${q.leadTimeDays} days` : ""}
                  {q.validUntil ? `, valid until ${formatDate(q.validUntil)}` : ""}
                  {q.notes ? <p className="mt-1 text-muted">{q.notes}</p> : null}
                  <p className="mt-1 text-xs text-muted">Sent {formatDateTime(q.createdAt)}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <QuoteForm conversationId={c.id} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Did this deal close?</CardTitle></CardHeader>
        <CardBody>
          <p className="mb-3 text-sm text-muted">Deals close off the platform for now. One tap keeps your record and trust score accurate.</p>
          <DealReportForm conversationId={c.id} matchId={c.matchId} current={c.dealReported} />
        </CardBody>
      </Card>
    </div>
  );
}
