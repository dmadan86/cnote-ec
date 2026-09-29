import { listVersionReviewQueue } from "@cnote/catalogue";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Listing versions" };

const TABS = [
  { value: "in_review", label: "Needs review" },
  { value: "approved", label: "Approved, not live yet" },
] as const;

const href = (status: string, cursor?: string) => `/listings?status=${status}${cursor ? `&cursor=${cursor}` : ""}`;
const verdictTone = (v: string) => (v.startsWith("block") ? "danger" : v === "allow" ? "success" : "warning");

export default async function ListingVersionsPage({ searchParams }: PageProps<"/listings">) {
  const sp = await searchParams;
  const status = one(sp.status) === "approved" ? "approved" : "in_review";
  const cursor = one(sp.cursor);
  await requireStaff(href(status, cursor), "listings.moderate");
  const queue = await safe("catalogue.listVersionReviewQueue", () => listVersionReviewQueue({ status, cursor, limit: 30 }));
  const items = queue?.items ?? [];
  return (
    <>
      <PageHeader title="Listing versions" description="Sellers edit a working copy and submit versions. Nothing reaches buyers until a version is approved and the publisher takes it live. Oldest first." />
      <LinkTabs label="Status" variant="underline" items={TABS.map((t) => ({ href: href(t.value), label: t.label, active: t.value === status }))} />
      {queue === null ? <Alert tone="warning">The version queue is currently unavailable.</Alert> : null}
      {queue && items.length === 0 ? <EmptyState title="Nothing waiting" description="No versions in this view." /> : null}
      <ul className="grid gap-3">
        {items.map((i) => (
          <li key={i.versionId}>
            <Card>
              <CardBody className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <Link href={`/listings/${i.versionId}`} className="block truncate font-semibold text-brand-700 hover:underline">
                    {i.title} <span className="font-normal text-muted">· v{i.version}</span>
                  </Link>
                  <p className="text-sm text-muted">
                    {i.sellerName} · tier {i.sellerTier} · trust {i.sellerTrustScore} · {fmtDate(i.createdAt)}
                  </p>
                  {i.changeNote ? <p className="text-sm">{i.changeNote}</p> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={i.firstVersion ? "brand" : "neutral"}>{i.firstVersion ? "New listing" : `${i.changeCount} change${i.changeCount === 1 ? "" : "s"}`}</Badge>
                  {i.aiVerdict ? <Badge tone={verdictTone(i.aiVerdict)}>AI: {i.aiVerdict.slice(0, 40)}</Badge> : null}
                  {i.publishAt ? <Badge tone="warning">Scheduled {fmtDate(i.publishAt)}</Badge> : null}
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
      {queue?.nextCursor ? <Link href={href(status, queue.nextCursor)} className="text-sm font-medium text-brand-700 hover:underline">Next page →</Link> : null}
    </>
  );
}
