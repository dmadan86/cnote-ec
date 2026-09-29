import { listImageModerationQueue, type ImageModerationItem } from "@cnote/catalogue";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import { redirect } from "next/navigation";
import Link from "next/link";
import { BULK_FORM_ID, BulkApproveBar } from "@/features/images/bulk-approve";
import { ImageDecisionForm } from "@/features/images/decision-form";
import { canModerateImages, canViewImages } from "@/features/images/privilege";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Image moderation" };

const STATUSES = [
  { value: undefined, label: "All open" },
  { value: "pending", label: "Pending" },
  { value: "flagged", label: "Flagged" },
] as const;

const href = (status?: string, cursor?: string) => {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return s ? `/images?${s}` : "/images";
};

const kb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const verdictTone = (v: string) => (v.startsWith("block") ? "danger" : v === "allow" ? "success" : "warning");

export default async function ImagesPage({ searchParams }: PageProps<"/images">) {
  const sp = await searchParams;
  const status = one(sp.status) === "pending" || one(sp.status) === "flagged" ? (one(sp.status) as "pending" | "flagged") : undefined;
  const cursor = one(sp.cursor);
  const { staff } = await requireStaff(href(status, cursor));
  if (!canViewImages(staff)) redirect("/no-access?need=images.moderate");
  const canModerate = canModerateImages(staff);

  const queue = await safe("catalogue.listImageModerationQueue", () => listImageModerationQueue({ status, cursor, limit: 24 }));
  const items = queue?.items ?? [];

  return (
    <>
      <PageHeader title="Image moderation" description="Seller photos are hidden from buyers until a staff member approves them. Oldest first." />
      <LinkTabs label="Status" variant="underline" items={STATUSES.map((s) => ({ href: href(s.value), label: s.label, active: s.value === status }))} />
      {!canModerate ? <Alert tone="info">You can view the queue but your role can&apos;t approve or reject images.</Alert> : null}
      {queue === null ? <Alert tone="warning">The image queue is currently unavailable.</Alert> : null}
      {queue && items.length === 0 ? <EmptyState title="Nothing waiting" description="No images in this view need a decision." /> : null}
      {canModerate && items.length ? <BulkApproveBar /> : null}
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((i: ImageModerationItem) => (
          <li key={i.id}>
            <Card className="h-full">
              <CardBody className="space-y-3">
                <Link href={`/images/${i.id}`} aria-label={`Open large preview: ${i.listingTitle}`} className="block focus-visible:outline-2 focus-visible:outline-brand-600">
                  {/* eslint-disable-next-line @next/next/no-img-element -- staff-gated no-store route */}
                  <img src={i.url} alt={i.altText ?? `Uploaded photo for ${i.listingTitle}`} loading="lazy" className="aspect-square w-full rounded-lg bg-canvas object-contain" />
                </Link>
                <div className="space-y-1 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={i.status === "flagged" ? "warning" : "neutral"}>{i.status}</Badge>
                    {i.aiVerdict ? <Badge tone={verdictTone(i.aiVerdict)}>AI: {i.aiVerdict}</Badge> : null}
                  </div>
                  <p className="font-semibold">{i.listingTitle}</p>
                  <p className="text-muted">{i.sellerName}</p>
                  <p className="text-xs text-muted">
                    {fmtDate(i.createdAt)} · {i.width ?? "?"}×{i.height ?? "?"} px · {kb(i.bytes)}
                  </p>
                </div>
                {canModerate ? (
                  <>
                    <label className="flex min-h-11 items-center gap-2 text-sm">
                      <input type="checkbox" name="ids" value={i.id} form={BULK_FORM_ID} className="size-4" />
                      Select for bulk approve
                    </label>
                    <ImageDecisionForm id={i.id} compact />
                  </>
                ) : null}
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
      {queue?.nextCursor ? <Link href={href(status, queue.nextCursor)} className="text-sm font-medium text-brand-700 hover:underline">Next page →</Link> : null}
    </>
  );
}
