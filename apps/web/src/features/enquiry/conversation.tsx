import { Money, cn } from "@cnote/ui";
import type { ConversationView } from "@cnote/enquiry";

type Item =
  | { kind: "message"; at: string; id: string; mine: boolean; body: string }
  | { kind: "quote"; at: string; id: string; quote: ConversationView["quotes"][number] };

const dt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

/**
 * Chronological thread of messages and quotes. Side-agnostic (takes the viewer's personId), so the
 * seller app can render the same component or build its own on top of getConversation().
 */
export function MessageThread({ conversation, myPersonId, counterpartyName }: { conversation: ConversationView; myPersonId: string; counterpartyName: string }) {
  const items: Item[] = [
    ...conversation.messages.map((m): Item => ({ kind: "message", at: m.createdAt, id: m.id, mine: m.senderPersonId === myPersonId, body: m.body })),
    ...conversation.quotes.map((q): Item => ({ kind: "quote", at: q.createdAt, id: q.id, quote: q })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  if (items.length === 0) return <p className="py-8 text-center text-sm text-muted">No messages yet. Say hello to {counterpartyName}.</p>;
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation">
      {items.map((it) =>
        it.kind === "message" ? (
          <li key={it.id} className={cn("flex", it.mine ? "justify-end" : "justify-start")}>
            <div className={cn("max-w-[85%] rounded-2xl px-4 py-2 text-sm", it.mine ? "bg-brand-600 text-white" : "border border-line bg-surface text-ink")}>
              <p className="whitespace-pre-wrap break-words">{it.body}</p>
              <p className={cn("mt-1 text-[11px]", it.mine ? "text-white/80" : "text-muted")}>
                {it.mine ? "You" : counterpartyName} · {dt.format(new Date(it.at))}
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
  return (
    <div className="rounded-card border border-accent-100 bg-accent-50 p-4 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-accent-700">Quote from {from}</p>
      <p className="mt-1 text-lg">
        <Money paise={quote.pricePaise} unit={quote.unit} />
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ink">
        <dt className="text-muted">Quantity</dt>
        <dd>{quote.quantity} {quote.unit}</dd>
        <dt className="text-muted">Total</dt>
        <dd><Money paise={quote.pricePaise * quote.quantity} /></dd>
        {quote.leadTimeDays !== null ? (<><dt className="text-muted">Lead time</dt><dd>{quote.leadTimeDays} days</dd></>) : null}
        {quote.validUntil ? (<><dt className="text-muted">Valid until</dt><dd>{quote.validUntil}</dd></>) : null}
      </dl>
      {quote.notes ? <p className="mt-2 whitespace-pre-wrap text-ink">{quote.notes}</p> : null}
      <p className="mt-2 text-[11px] text-muted">{dt.format(new Date(at))}</p>
    </div>
  );
}
