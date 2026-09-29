import { getStorefrontVersionForReview } from "@cnote/storefront";
import { StorefrontView, findPage, type RenderHrefs } from "@cnote/storefront/render";
import { collectText } from "@cnote/storefront/document";
import { Alert, Badge, Card, CardBody, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Mono } from "@/components/table";
import { ReviewForm } from "@/features/storefronts/controls";
import { requireStaff } from "@/lib/auth";
import { fmtDate } from "@/lib/util";

export const metadata = { title: "Review storefront version" };
const hrefs = (versionId: string): RenderHrefs => ({ page: (s) => `/storefronts/review/${versionId}?page=${s}`, product: () => "#", rfq: "#" });

export default async function ReviewDetail(props: { params: Promise<{ versionId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { versionId } = await props.params;
  await requireStaff(`/storefronts/review/${versionId}`, "storefronts.review");
  const item = await getStorefrontVersionForReview(versionId).catch(() => null);
  if (!item) notFound();
  const sp = await props.searchParams;
  const pageParam = Array.isArray(sp.page) ? sp.page[0] : sp.page;
  const page = findPage(item.document, pageParam);
  const texts = collectText(item.document);
  const open = item.item.status === "in_review";
  return (
    <>
      <PageHeader title={`${item.item.businessName}: version ${item.item.version}`} description={<><Mono>{item.item.slug}</Mono> · submitted {fmtDate(item.item.createdAt)} · <Badge tone={open ? "warning" : "neutral"}>{item.item.status.replace("_", " ")}</Badge></>} actions={<Link href="/storefronts/review" className="text-sm font-medium text-brand-700 hover:underline">Back to queue</Link>} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section aria-label="Storefront preview" className="min-w-0">
          <div className="mb-2 flex flex-wrap gap-2">
            {item.document.pages.map((p) => <Link key={p.slug} href={`/storefronts/review/${versionId}?page=${p.slug}`} aria-current={p.slug === page.slug ? "page" : undefined} className={`rounded-full border px-3 py-1 text-sm ${p.slug === page.slug ? "border-brand-600 bg-brand-50 font-semibold text-brand-700" : "border-line bg-surface"}`}>{p.title}</Link>)}
          </div>
          <div className="max-h-[80vh] overflow-auto rounded-card border border-line bg-surface">
            <StorefrontView document={item.document} pageSlug={page.slug} data={item.data} hrefs={hrefs(versionId)} preview />
          </div>
        </section>
        <aside className="space-y-4">
          <Card><CardBody className="space-y-2 p-4">
            <h2 className="text-sm font-semibold text-ink">Automated screening</h2>
            <p className="text-sm text-ink">{item.item.aiVerdict ?? "No verdict recorded."}</p>
            {item.item.reviewNote ? <p className="text-sm text-muted">Note: {item.item.reviewNote}</p> : null}
          </CardBody></Card>
          {open ? <Card><CardBody className="p-4"><h2 className="mb-3 text-sm font-semibold text-ink">Decision</h2><ReviewForm versionId={versionId} /></CardBody></Card> : <Alert tone="info">This version has already been decided.</Alert>}
          <Card><CardBody className="space-y-2 p-4">
            <h2 className="text-sm font-semibold text-ink">All seller-written text ({texts.length} items)</h2>
            <ul className="max-h-96 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-ink">{texts.map((t, i) => <li key={i}>{t.length > 300 ? `${t.slice(0, 300)}…` : t}</li>)}</ul>
          </CardBody></Card>
        </aside>
      </div>
    </>
  );
}
