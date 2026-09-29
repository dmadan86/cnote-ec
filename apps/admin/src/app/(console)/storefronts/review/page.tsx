import { listStorefronts, listStorefrontReviews, type StorefrontStatus } from "@cnote/storefront";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { ReinstateForm, SuspendForm } from "@/features/storefronts/controls";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Storefront review" };
const TONE = { draft: "neutral", live: "success", suspended: "danger" } as const;

export default async function StorefrontReviewPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaff("/storefronts/review", "storefronts.review");
  const sp = await props.searchParams;
  const q = one(sp.q);
  const status = one(sp.status) as StorefrontStatus | undefined;
  const [queue, list] = await Promise.all([
    safe("storefront.listStorefrontReviews", () => listStorefrontReviews({ status: "in_review" })),
    safe("storefront.listStorefronts", () => listStorefronts({ q, status: status && ["draft", "live", "suspended"].includes(status) ? status : undefined, limit: 50 })),
  ]);
  return (
    <>
      <PageHeader title="Storefront review" description="Storefront versions the AI pre-screen flagged. Nothing flagged goes live until a person approves it. Suspending hides a live storefront immediately." />
      {queue === null ? <Alert tone="warning">The review queue is currently unavailable.</Alert> : queue.length === 0 ? <EmptyState title="Queue is clear" description="No storefront versions are waiting for review." /> : (
        <section aria-labelledby="q-h" className="space-y-2">
          <h2 id="q-h" className="text-sm font-semibold uppercase tracking-wide text-muted">Waiting for review <Badge tone="brand">{queue.length}</Badge></h2>
          <Table>
            <thead><tr><Th>Storefront</Th><Th>Version</Th><Th>AI verdict</Th><Th>Submitted</Th><Th /></tr></thead>
            <tbody>
              {queue.map((i) => (
                <tr key={i.versionId}>
                  <Td><p className="font-medium">{i.businessName}</p><Mono>{i.slug}</Mono></Td>
                  <Td>v{i.version}</Td>
                  <Td className="max-w-md">{i.aiVerdict ?? "n/a"}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(i.createdAt)}</Td>
                  <Td className="text-right"><Link href={`/storefronts/review/${i.versionId}`} className="font-medium text-brand-700 hover:underline">Review</Link></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      )}

      <section aria-labelledby="all-h" className="space-y-3">
        <h2 id="all-h" className="text-sm font-semibold uppercase tracking-wide text-muted">All storefronts</h2>
        <form className="flex flex-wrap items-end gap-2" role="search">
          <label className="text-sm font-medium">Address contains<input name="q" defaultValue={q ?? ""} className="mt-1 block h-10 rounded-lg border border-line bg-surface px-3 text-sm" /></label>
          <label className="text-sm font-medium">Status
            <select name="status" defaultValue={status ?? ""} className="mt-1 block h-10 rounded-lg border border-line bg-surface px-3 text-sm">
              <option value="">Any</option><option value="live">Live</option><option value="draft">Not published</option><option value="suspended">Suspended</option>
            </select>
          </label>
          <button type="submit" className="h-10 rounded-full border border-line bg-surface px-4 text-sm font-medium hover:bg-canvas">Filter</button>
        </form>
        {list === null ? <Alert tone="warning">Storefronts are currently unavailable.</Alert> : list.length === 0 ? <EmptyState title="No storefronts found" /> : (
          <Table>
            <thead><tr><Th>Storefront</Th><Th>Status</Th><Th>Updated</Th><Th>Action</Th></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <Td><p className="font-medium">{s.businessName}</p><Mono>{s.slug}</Mono></Td>
                  <Td><Badge tone={TONE[s.status]}>{s.status}</Badge>{s.suspendedReason ? <p className="mt-1 max-w-xs text-xs text-muted">{s.suspendedReason}</p> : null}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(s.updatedAt)}</Td>
                  <Td>{s.status === "suspended" ? <ReinstateForm storefrontId={s.id} /> : <SuspendForm storefrontId={s.id} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
