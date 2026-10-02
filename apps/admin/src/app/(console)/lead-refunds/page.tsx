import { listRefundReviews } from "@cnote/enquiry";
import { Alert, Button, EmptyState, PageHeader } from "@cnote/ui";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe, shortId } from "@/lib/util";
import { decideRefundReviewAction } from "./actions";

export const metadata = { title: "Lead refund requests" };

const REASON: Record<string, string> = { refund_rate: "Refund rate above the limit", refund_burst: "Too many refunds this week" };

export default async function LeadRefundsPage() {
  await requireStaff("/lead-refunds", "enquiries.review");
  const items = await safe("enquiry.listRefundReviews", () => listRefundReviews({ limit: 200 }));
  if (items === null) return (<><PageHeader title="Lead refund requests" /><Alert tone="warning">The queue is currently unavailable.</Alert></>);
  return (
    <>
      <PageHeader
        title="Lead refund requests"
        description="Buyer-fake refund requests held because the seller's refund rate or weekly count is abnormal (ADR-002 anti-abuse). Approve to refund the credit and close the lead; reject to keep it accepted."
      />
      {items.length === 0 ? <EmptyState title="Nothing held" description="No refund requests are waiting for a decision." /> : null}
      {items.length > 0 ? (
        <Table>
          <thead><tr><Th>Seller</Th><Th>Lead</Th><Th>Why held</Th><Th>30-day refund rate</Th><Th>Requested</Th><Th /></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <Td><Mono>{shortId(r.sellerBusinessId)}</Mono></Td>
                <Td><Mono>{shortId(r.matchId)}</Mono></Td>
                <Td>{REASON[r.reason] ?? r.reason}</Td>
                <Td>{(r.refundRateBps / 100).toFixed(1)}%</Td>
                <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td>
                <Td className="text-right">
                  <form action={decideRefundReviewAction} className="flex justify-end gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    <Button type="submit" name="decision" value="approved" size="sm" variant="outline">Refund</Button>
                    <Button type="submit" name="decision" value="rejected" size="sm" variant="outline">Reject</Button>
                  </form>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}
    </>
  );
}
