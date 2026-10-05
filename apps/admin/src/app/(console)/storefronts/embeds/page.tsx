import { listEmbedReviews, type EmbedReviewItem } from "@cnote/storefront";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import { FilterActions, FilterBar, FilterField, FilterSelect } from "@/components/filters";
import { Mono, Table, Td, Th } from "@/components/table";
import { EmbedReviewForm } from "@/features/storefronts/controls";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Storefront embeds" };
const TONE = { pending: "warning", approved: "success", rejected: "danger" } as const;
const STATUSES = ["pending", "approved", "rejected"] as const;

export default async function StorefrontEmbedsPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaff("/storefronts/embeds", "storefronts.review");
  const sp = await props.searchParams;
  const raw = one(sp.status);
  const status = (STATUSES as readonly string[]).includes(raw ?? "") ? (raw as (typeof STATUSES)[number]) : "pending";
  const items = await safe("storefront.listEmbedReviews", () => listEmbedReviews({ status, limit: 100 }));
  return (
    <>
      <PageHeader
        title="Storefront embeds"
        description="Third-party videos (YouTube, Vimeo) that sellers embedded in their storefronts. A video is hidden from visitors until it is approved here or by the trusted-seller rules. The title, channel and description are the provider's public metadata; open the video to judge it. Approved videos are re-checked weekly."
      />
      <FilterBar label="Filter embeds">
        <FilterField label="Status" width="md">
          <FilterSelect name="status" defaultValue={status}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</FilterSelect>
        </FilterField>
        <FilterActions clearHref={status !== "pending" ? "/storefronts/embeds" : undefined} />
      </FilterBar>
      {items === null ? <Alert tone="warning">Embeds are currently unavailable.</Alert> : items.length === 0 ? <EmptyState title="Nothing here" description={`No ${status} embeds.`} /> : (
        <Table>
          <caption className="sr-only">Storefront video embeds, oldest first</caption>
          <thead><tr><Th>Seller</Th><Th>Video</Th><Th>Screening</Th><Th>Added</Th><Th>{status === "pending" ? "Decision" : "Decided"}</Th></tr></thead>
          <tbody>
            {items.map((i: EmbedReviewItem) => (
              <tr key={i.id}>
                <Td><p className="font-medium">{i.businessName}</p><Mono>{i.slug}</Mono></Td>
                <Td className="max-w-md">
                  <p className="font-medium">{i.title ?? "(metadata not fetched yet)"}</p>
                  <p className="text-xs text-muted">{i.provider}{i.authorName ? ` · ${i.authorName}` : ""}</p>
                  {i.description ? <p className="mt-1 line-clamp-3 text-xs text-muted">{i.description}</p> : null}
                  <a href={i.href} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 inline-block text-xs font-medium text-brand-700 hover:underline">Open on {i.provider === "vimeo" ? "Vimeo" : "YouTube"}<span className="sr-only"> (new tab)</span></a>
                </Td>
                <Td className="max-w-xs text-xs">
                  <Badge tone={TONE[i.status]}>{i.status}</Badge>
                  <p className="mt-1">{i.aiVerdict ?? "not screened"}</p>
                  {i.fetchError ? <p className="mt-1 text-danger">Could not fetch: {i.fetchError}</p> : null}
                  {i.thumbnailUrl ? null : <p className="mt-1 text-muted">No thumbnail from the provider&apos;s image host.</p>}
                </Td>
                <Td className="whitespace-nowrap">{fmtDate(i.createdAt)}</Td>
                <Td className="min-w-64">
                  {status === "pending" ? <EmbedReviewForm embedId={i.id} /> : <p className="text-xs">{i.decidedBy ?? "n/a"}{i.reviewNote ? `: ${i.reviewNote}` : ""}</p>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
