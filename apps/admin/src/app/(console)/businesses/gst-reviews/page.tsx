import { hasPrivilege } from "@cnote/admin";
import { listPendingGstReviews } from "@cnote/identity";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "GST reviews" };

export default async function GstReviewsPage() {
  const { staff } = await requireStaff("/businesses/gst-reviews", "businesses.read");
  const items = await safe("identity.listPendingGstReviews", () => listPendingGstReviews(100));
  const canVerify = hasPrivilege(staff, "businesses.verify");
  return (
    <>
      <PageHeader title="GST reviews" description="Ambiguous GST checks (partial name match, state mismatch, missing data) waiting for a person." />
      {items === null ? <Alert tone="warning">The GST review queue is currently unavailable.</Alert> : items.length === 0 ? <EmptyState title="Nothing to review" /> : (
        <Table>
          <thead><tr><Th>Queued</Th><Th>Business</Th><Th>GSTIN</Th><Th>Score</Th><Th>Why</Th><Th /></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td>
                <Td className="font-medium">{r.businessName}{r.dispute ? <> <Badge tone="warning">GSTIN dispute</Badge></> : null}</Td>
                <Td><Mono>{r.gstin ?? "—"}</Mono></Td>
                <Td>{r.score ?? "—"}</Td>
                <Td className="max-w-sm text-sm text-muted">{r.reasons.join(" ") || "—"}</Td>
                <Td className="text-right"><Link href={`/businesses/${r.businessId}`} className="font-medium text-brand-700 hover:underline">{canVerify ? "Review" : "Open"}</Link></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
