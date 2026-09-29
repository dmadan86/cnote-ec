import { createPreviewToken, getVersionForReview, type VersionSnapshot } from "@cnote/catalogue";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { VersionReviewForm } from "@/features/listings/review-form";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Version review" };

const WEB_ORIGIN = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const STATUS_TONE = { submitted: "warning", in_review: "warning", approved: "brand", published: "success", superseded: "neutral", rejected: "danger", withdrawn: "neutral" } as const;
const verdictTone = (v: string) => (v.startsWith("block") ? "danger" : v === "allow" ? "success" : "warning");

const show = (v: string | number | null | undefined) => (v === null || v === undefined || v === "" ? "—" : String(v));
const money = (p: number | null) => (p === null ? null : `₹${(p / 100).toLocaleString("en-IN")}`);

/** Rows compared column by column; a changed row is highlighted. */
function rows(live: VersionSnapshot | null, next: VersionSnapshot): { label: string; live: string; next: string; changed: boolean }[] {
  const keys = [...new Set([...Object.keys(live?.attributes ?? {}), ...Object.keys(next.attributes)])].sort();
  const base: [string, string | number | null | undefined, string | number | null | undefined][] = [
    ["Title", live?.title, next.title],
    ["Category", live?.categoryName, next.categoryName],
    ["Description", live?.description, next.description],
    ["Price", money(live?.pricePaise ?? null), money(next.pricePaise)],
    ["Price unit", live?.priceUnit, next.priceUnit],
    ["Min. order", live?.moq != null ? `${live.moq} ${live.moqUnit ?? ""}` : null, next.moq != null ? `${next.moq} ${next.moqUnit ?? ""}` : null],
    ["HSN", live?.hsn, next.hsn],
    ["Language", live?.language, next.language],
    ...keys.map((k): [string, string | number | null | undefined, string | number | null | undefined] => [`Spec: ${k}`, live?.attributes[k], next.attributes[k]]),
  ];
  return base.map(([label, a, b]) => ({ label, live: show(a), next: show(b), changed: show(a) !== show(b) }));
}

function Images({ ids, other }: { ids: string[]; other: string[] }) {
  if (!ids.length) return <p className="text-sm text-muted">No uploaded images</p>;
  return (
    <ul className="grid grid-cols-4 gap-2">
      {ids.map((id) => (
        <li key={id} className={`overflow-hidden rounded-lg border ${other.includes(id) ? "border-line" : "border-amber-400 ring-2 ring-amber-200"}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- staff-gated no-store route */}
          <img src={`/media/listing-images/${id}`} alt="" loading="lazy" className="aspect-square w-full bg-canvas object-contain" />
        </li>
      ))}
    </ul>
  );
}

export default async function VersionReviewPage({ params }: PageProps<"/listings/[versionId]">) {
  const { versionId } = await params;
  await requireStaff(`/listings/${versionId}`, "listings.moderate");
  const r = await safe("catalogue.getVersionForReview", () => getVersionForReview(versionId));
  if (!r) notFound();
  const v = r.version;
  const table = rows(r.live?.snapshot ?? null, v.snapshot);
  const decidable = v.status === "in_review" || v.status === "submitted";
  const previewUrl = `${WEB_ORIGIN}/preview/listing/${v.id}?token=${encodeURIComponent(createPreviewToken(v.id))}`;

  return (
    <>
      <PageHeader
        title={`${r.listingTitle} · version ${v.version}`}
        description={
          <>
            <Link href="/listings" className="text-brand-700 hover:underline">Queue</Link> · submitted {fmtDate(v.createdAt)}
            {v.publishAt ? <> · scheduled for {fmtDate(v.publishAt)}</> : null}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>{r.live ? `Live (v${r.live.version}) vs submitted (v${v.version})` : "First version (nothing live yet)"}</CardTitle>
            <Badge tone={STATUS_TONE[v.status]}>{v.status.replace("_", " ")}</Badge>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted">
                    <th className="w-32 py-1.5 pr-3">Field</th>
                    <th className="py-1.5 pr-3">Live</th>
                    <th className="py-1.5">Submitted</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line align-top">
                  {table.map((row) => (
                    <tr key={row.label} className={row.changed ? "bg-amber-50" : undefined}>
                      <th scope="row" className="py-2 pr-3 text-left font-normal text-muted">{row.label}</th>
                      <td className={`whitespace-pre-line py-2 pr-3 ${row.changed ? "text-muted line-through decoration-danger/50" : ""}`}>{row.live}</td>
                      <td className={`whitespace-pre-line py-2 ${row.changed ? "font-medium text-ink" : ""}`}>{row.next}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Live images</h3>
                <Images ids={r.live?.snapshot.imageIds ?? []} other={v.snapshot.imageIds} />
              </div>
              <div>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Submitted images (new = highlighted)</h3>
                <Images ids={v.snapshot.imageIds} other={r.live?.snapshot.imageIds ?? []} />
              </div>
            </div>
          </CardBody>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Screening</CardTitle></CardHeader>
            <CardBody className="space-y-2 text-sm">
              <p>{v.aiVerdict ? <Badge tone={verdictTone(v.aiVerdict)}>AI: {v.aiVerdict}</Badge> : "No AI verdict"}</p>
              {r.seller ? (
                <p className="text-muted">
                  <span className="font-medium text-ink">{r.seller.name}</span> · tier {r.seller.tier} · trust {r.seller.trustScore}
                  {r.seller.city ? ` · ${r.seller.city}` : ""}
                </p>
              ) : null}
              {v.changeNote ? <p><span className="text-muted">Seller note:</span> {v.changeNote}</p> : null}
              {v.reviewNote ? <p><span className="text-muted">Reviewer note:</span> {v.reviewNote}</p> : null}
              <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-block font-medium text-brand-700 hover:underline">Open buyer-page preview →</a>
            </CardBody>
          </Card>
          <Card>
            <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
            <CardBody>
              {decidable ? <VersionReviewForm versionId={v.id} /> : <Alert tone="info">This version is already {v.status.replace("_", " ")}{v.reviewedAt ? ` (${fmtDate(v.reviewedAt)})` : ""}.</Alert>}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
