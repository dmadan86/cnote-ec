import { listOpenReviews, type ReviewItemView } from "@cnote/ai";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { ConfidenceBadge } from "@/components/confidence";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe, shortId } from "@/lib/util";

export const metadata = { title: "Review queue" };

export default async function ReviewsPage() {
  await requireStaff("/reviews", "reviews.read");
  const items = await safe("ai.listOpenReviews", () => listOpenReviews(200));
  if (items === null) return (<><PageHeader title="Review queue" /><Alert tone="warning">The review queue is currently unavailable.</Alert></>);
  const groups = new Map<string, ReviewItemView[]>();
  for (const i of items) groups.set(i.capability, [...(groups.get(i.capability) ?? []), i]);
  return (
    <>
      <PageHeader title="Review queue" description="AI decisions below the confidence threshold, awaiting a human (ADR-008). Oldest first within each capability." />
      {items.length === 0 ? <EmptyState title="Queue is clear" description="Nothing is waiting for review." /> : null}
      {[...groups].map(([capability, list]) => (
        <section key={capability} className="space-y-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            {capability} <Badge tone="brand">{list.length}</Badge>
          </h2>
          <Table>
            <thead><tr><Th>Subject</Th><Th>Reason</Th><Th>Confidence</Th><Th>Queued</Th><Th /></tr></thead>
            <tbody>
              {[...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => (
                <tr key={r.id}>
                  <Td>{r.subjectType} <Mono>{shortId(r.subjectId)}</Mono></Td>
                  <Td className="max-w-md">{r.reason}</Td>
                  <Td><ConfidenceBadge value={r.confidence} /></Td>
                  <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td>
                  <Td className="text-right"><Link href={`/reviews/${r.id}`} className="font-medium text-brand-700 hover:underline">Review</Link></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ))}
    </>
  );
}
