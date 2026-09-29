import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { EyeOff, MapPin } from "lucide-react";
import { Avatar, Card, CardBody, Container, Money, TrustBadge } from "@cnote/ui";
import { getCategoryById, getPreviewByToken, verifyPreviewToken } from "@cnote/catalogue";
import { moqText } from "@/features/search/format";

// Not-live preview of ONE listing version (per ADR-003 nothing is public before review). Requires a valid HMAC token
// (?token=, 1h) minted by the seller/admin app. Dynamic + no-store + noindex: it must never be cached or crawled.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Preview (not live)",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noarchive: true, nosnippet: true } },
  referrer: "no-referrer",
};

const prettify = (k: string) => k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

const STATUS_TEXT: Record<string, string> = {
  submitted: "submitted",
  in_review: "waiting for review",
  approved: "approved, waiting to go live",
  published: "live",
  superseded: "replaced by a newer version",
  rejected: "rejected",
  withdrawn: "withdrawn",
};

export default async function PreviewListingPage(props: PageProps<"/preview/listing/[versionId]">) {
  const { versionId } = await props.params;
  const sp = await props.searchParams;
  const token = typeof sp.token === "string" ? sp.token : undefined;
  const ok = verifyPreviewToken(token);
  if (!ok || ok.versionId !== versionId) notFound();
  const l = await getPreviewByToken(token);
  if (!l) notFound();
  const { preview: p } = l;
  const category = await getCategoryById(l.category.id);
  const fields = new Map((category?.attributeSchema.fields ?? []).map((f) => [f.key, f]));
  const moq = moqText(l);
  const imgs = p.imageIds.length
    ? p.imageIds.map((id) => `/preview/listing/${versionId}/media/${id}?token=${encodeURIComponent(token!)}`)
    : l.imageUrls;
  const facts: [string, string][] = [
    ...Object.entries(l.attributes).filter(([, v]) => v !== "" && v != null).map(([k, v]): [string, string] => {
      const f = fields.get(k);
      return [f?.label ?? prettify(k), `${String(v)}${f?.unit ? ` ${f.unit}` : ""}`];
    }),
    ...(l.hsn ? ([["HSN code", l.hsn]] as [string, string][]) : []),
    ["Category", l.category.name],
    ...(moq ? ([["Minimum order", moq]] as [string, string][]) : []),
  ];

  return (
    <div>
      <div role="status" className="sticky top-0 z-50 border-b-2 border-amber-400 bg-amber-100 px-4 py-3 text-center text-sm font-semibold text-amber-950">
        <EyeOff className="mr-2 inline size-4 align-text-bottom" aria-hidden />
        Preview, not live. Version {p.version} is {STATUS_TEXT[p.versionStatus] ?? p.versionStatus}
        {p.publishAt ? ` (scheduled ${new Date(p.publishAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })})` : ""}. Buyers cannot see this page.
      </div>
      <Container className="py-6 lg:py-8">
        {p.changeNote ? <p className="mb-4 rounded-card border border-line bg-surface px-4 py-2 text-sm text-muted">Change note: {p.changeNote}</p> : null}
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-card border border-line bg-surface">
              {imgs[0] ? (
                // Token-gated, per-request URL: `unoptimized` bypasses the optimiser cache on purpose.
                <Image src={imgs[0]} alt={l.title} width={800} height={800} unoptimized className="size-full object-contain p-2" />
              ) : (
                <span className="text-sm text-muted">No image</span>
              )}
            </div>
            {imgs.length > 1 ? (
              <ul className="mt-3 grid grid-cols-4 gap-3">
                {imgs.slice(1, 5).map((u, i) => (
                  <li key={u} className="relative aspect-square overflow-hidden rounded-lg border border-line bg-surface">
                    <Image src={u} alt={`${l.title}, image ${i + 2}`} width={200} height={200} unoptimized className="size-full object-contain p-1" />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="flex flex-col gap-5">
            <div>
              <h1 className="text-2xl font-bold leading-tight tracking-tight text-ink sm:text-3xl">{l.title}</h1>
              <div className="mt-3">
                {l.pricePaise != null ? <Money paise={l.pricePaise} unit={l.priceUnit} className="text-3xl" /> : <span className="text-lg font-semibold text-muted">Price on request</span>}
              </div>
              {moq ? <p className="mt-1 text-sm text-muted">Min. order: {moq}</p> : null}
              <p className="mt-1 text-xs text-muted">Indicative price. The supplier confirms the final quote for your quantity and delivery location.</p>
            </div>

            {p.seller ? (
              <Card>
                <CardBody className="flex items-start gap-3">
                  <Avatar name={p.seller.name} size="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted">Supplier</p>
                    <h2 className="truncate text-base font-semibold text-ink">{p.seller.name}</h2>
                    <p className="mt-0.5 inline-flex items-center gap-1 text-sm text-muted">
                      <MapPin className="size-3.5" aria-hidden /> {[p.seller.city, p.seller.state].filter(Boolean).join(", ") || "India"}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <TrustBadge tier={p.seller.verificationTier} badgeActive={p.seller.badgeActive} />
                      <span className="text-xs text-muted">Trust score {p.seller.trustScore}/100</span>
                    </div>
                  </div>
                </CardBody>
              </Card>
            ) : null}

            {l.description ? (
              <section aria-labelledby="desc">
                <h2 id="desc" className="text-base font-bold text-ink">Description</h2>
                <p className="mt-1.5 whitespace-pre-line text-sm leading-6 text-ink/80">{l.description}</p>
              </section>
            ) : null}

            <section aria-labelledby="specs">
              <h2 id="specs" className="text-base font-bold text-ink">Specifications</h2>
              <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">Specifications of {l.title}</caption>
                  <tbody className="divide-y divide-line">
                    {facts.map(([k, v]) => (
                      <tr key={k}>
                        <th scope="row" className="w-40 px-4 py-2.5 text-left font-normal text-muted">{k}</th>
                        <td className="px-4 py-2.5 font-medium text-ink">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </Container>
    </div>
  );
}
