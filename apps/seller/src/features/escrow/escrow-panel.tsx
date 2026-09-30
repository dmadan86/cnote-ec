import { getEscrowForOrder, type EscrowView } from "@cnote/escrow";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Money, type BadgeTone } from "@cnote/ui";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";

const TONE: Record<string, BadgeTone> = { created: "neutral", awaiting_funding: "warning", funded: "brand", accepted: "success", released: "success", refunded: "neutral", cancelled: "neutral" };
const LABEL: Record<string, string> = {
  created: "Buyer has not started", awaiting_funding: "Waiting for the buyer's payment", funded: "Payment held safely in escrow", accepted: "Accepted by the buyer",
  released: "Released to you", refunded: "Refunded to the buyer", cancelled: "Closed without payment",
};
const STEP: Record<string, string> = { funded: "Buyer paid into escrow", confirmed: "Order confirmed", dispatched: "You dispatched", delivered: "Delivered", accepted: "Buyer accepted delivery", released: "Released to you", refunded: "Refunded to the buyer" };
const STEPS = ["funded", "confirmed", "dispatched", "delivered", "accepted"];

/** Seller view of an order's escrow (ADR-012): milestone status, fee disclosure and payout state. Read-only. */
export async function EscrowPanel({ actor, orderId }: { actor: { personId: string; businessId: string }; orderId: string }) {
  const res = await load(() => getEscrowForOrder(actor, orderId));
  if (!res.ok || !res.data) return null;
  const e: EscrowView = res.data;
  const final = e.milestones.find((m) => m.milestone === "released" || m.milestone === "refunded")?.milestone;
  const steps = final ? [...STEPS, final] : STEPS;
  const at = (m: string) => e.milestones.find((x) => x.milestone === m)?.at;
  const held = e.status === "funded" || e.status === "accepted";
  return (
    <section aria-labelledby="escrow-heading">
      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle id="escrow-heading">Escrow payment</CardTitle>
          <Badge tone={TONE[e.status] ?? "neutral"}><span className="sr-only">Escrow status: </span>{LABEL[e.status] ?? e.status}</Badge>
        </CardHeader>
        <CardBody className="space-y-4 text-sm">
          {e.frozen ? <Alert tone="warning">A dispute is open. The money is frozen and will not be released until it is resolved.</Alert> : null}
          {held ? <p>Do not dispatch on credit: the buyer has paid and the money is safe. It is released to you when the buyer accepts delivery{e.autoReleaseAt && !e.frozen ? `, or automatically on ${formatDateTime(e.autoReleaseAt)}` : ", or automatically 7 days after delivery if there is no dispute"}.</p> : null}
          {e.status === "awaiting_funding" ? <p>Wait for the buyer&apos;s payment before you dispatch. You will see it here as soon as it arrives.</p> : null}
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Row k="Order value" v={<Money paise={e.amountPaise} />} />
            <Row k="Escrow fee (charged to you, plus GST)" v={<><Money paise={e.feePaise} /> + <Money paise={e.feeGstPaise} /></>} />
            <Row k="You receive" v={<Money paise={e.sellerNetPaise} />} />
            <Row k="Payout" v={e.payout ? `${e.payout.status === "settled" ? "Paid" : e.payout.status === "failed" ? "Failed, our team is on it" : "On its way"}${e.payout.settledAt ? `, ${formatDateTime(e.payout.settledAt)}` : ""}` : "Not released yet"} />
          </dl>
          <div>
            <h3 className="font-semibold text-ink">Progress</h3>
            <ol className="mt-2 space-y-2">
              {steps.map((m) => (
                <li key={m} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-0">
                  <span className={at(m) ? "font-medium text-ink" : "text-muted"}>{STEP[m]}</span>
                  <span className="text-muted">{at(m) ? `Done, ${formatDateTime(at(m)!)}` : "Pending"}</span>
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
