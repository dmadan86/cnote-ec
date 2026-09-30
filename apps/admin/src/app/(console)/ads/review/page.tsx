import { listReviewQueue } from "@cnote/ads";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe, shortId } from "@/lib/util";
import { AdsNav } from "../ads-nav";

export const metadata = { title: "Ad review queue" };

export default async function AdReviewQueue() {
  await requireStaff("/ads/review", "ads.review");
  const rows = await safe("ads.queue", () => listReviewQueue(200));
  return (
    <>
      <PageHeader title="Ad review queue" description="New and materially changed campaigns. Approve or reject each keyword and product on its own, then decide the campaign. Target: one business day." />
      <AdsNav active="/ads/review" />
      {rows === null ? <Alert tone="warning">The queue is unavailable.</Alert> : rows.length === 0 ? <EmptyState title="Queue is clear" description="No campaign is waiting for review." /> : (
        <Table>
          <thead><tr><Th>Campaign</Th><Th>Seller</Th><Th>Status</Th><Th>Daily budget</Th><Th>Pending items</Th><Th>Submitted</Th><Th /></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium">{c.name}</Td>
                <Td><Mono>{shortId(c.sellerBusinessId)}</Mono></Td>
                <Td><Badge tone={c.status === "pending_review" ? "warning" : "neutral"}>{c.status.replace("_", " ")}</Badge></Td>
                <Td>₹{(c.dailyBudgetPaise / 100).toLocaleString("en-IN")}</Td>
                <Td>{c.pendingItems}</Td>
                <Td className="whitespace-nowrap">{c.submittedAt ? fmtDate(c.submittedAt) : ""}</Td>
                <Td className="text-right"><Link href={`/ads/review/${c.id}`} className="font-medium text-brand-700 hover:underline">Review</Link></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
