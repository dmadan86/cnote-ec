import { hasPrivilege, listAuditLog } from "@cnote/admin";
import { countOpenReviews } from "@cnote/ai";
import { Alert, Card, CardBody, CardHeader, CardTitle, PageHeader, Stat } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { ctx, staff } = await requireStaff("/");
  const canReviews = hasPrivilege(staff, "reviews.read");
  const [counts, audit] = await Promise.all([
    canReviews
      ? safe("ai.countOpenReviews", async () => {
          const [all, listing, enquiry] = await Promise.all([countOpenReviews(), countOpenReviews("listing"), countOpenReviews("enquiry")]);
          return { all, listing, enquiry };
        })
      : null,
    hasPrivilege(staff, "audit.read") ? safe("audit", () => listAuditLog(ctx, { limit: 8 })) : null,
  ]);
  return (
    <>
      <PageHeader title="Dashboard" description="What needs a human today." />
      {canReviews ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Open reviews" value={counts ? String(counts.all) : "—"} hint={<Link href="/reviews" className="text-brand-700 hover:underline">Open queue</Link>} />
          <Stat label="Listings pending moderation" value={counts ? String(counts.listing) : "—"} />
          <Stat label="Enquiries in review" value={counts ? String(counts.enquiry) : "—"} />
        </div>
      ) : (
        <Alert tone="info">Your role doesn&apos;t include the review queue. Use the sidebar for the sections you can access.</Alert>
      )}
      {canReviews && counts === null ? <Alert tone="warning">The review queue is currently unavailable.</Alert> : null}
      {audit ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <Link href="/audit" className="text-sm text-brand-700 hover:underline">View all</Link>
          </CardHeader>
          <CardBody>
            {audit.items.length === 0 ? (
              <p className="text-sm text-muted">No activity yet.</p>
            ) : (
              <Table>
                <thead><tr><Th>When</Th><Th>Action</Th><Th>Subject</Th><Th>Result</Th></tr></thead>
                <tbody>
                  {audit.items.map((e) => (
                    <tr key={e.id}>
                      <Td className="whitespace-nowrap">{fmtDate(e.createdAt)}</Td>
                      <Td><Mono>{e.action}</Mono></Td>
                      <Td>{e.subjectType ? `${e.subjectType}:${e.subjectId?.slice(0, 8) ?? ""}` : "—"}</Td>
                      <Td>{e.details.error ? "failed" : e.details.denied ? "denied" : "ok"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
