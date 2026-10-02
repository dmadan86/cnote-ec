import { getCampaignForReview, getPublicRateCard } from "@cnote/ads";
import { getListingsByIds, listCategories } from "@cnote/catalogue";
import { getTrustProfiles } from "@cnote/identity";
import { Alert, Badge, PageHeader, type BadgeTone } from "@cnote/ui";
import { notFound } from "next/navigation";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";
import { AdsNav } from "../../ads-nav";
import { DecideCampaignForm, ItemReviewForm } from "../../forms";

export const metadata = { title: "Review ad campaign" };
const TONE: Record<string, BadgeTone> = { pending: "warning", approved: "success", rejected: "danger" };

export default async function ReviewCampaign({ params }: PageProps<"/ads/review/[id]">) {
  const { id } = await params;
  await requireStaff(`/ads/review/${id}`, "ads.review");
  const c = await safe("ads.review", () => getCampaignForReview(id));
  if (!c) notFound();
  const listingIds = c.adGroups.flatMap((g) => g.listings.map((l) => l.listingId));
  const [listings, trust, cats, rates] = await Promise.all([
    safe("listings", () => getListingsByIds(listingIds)),
    safe("trust", () => getTrustProfiles([c.sellerBusinessId])),
    safe("categories", () => listCategories()),
    safe("rates", () => getPublicRateCard()),
  ]);
  const byId = new Map((listings ?? []).map((l) => [l.id, l]));
  const catName = new Map((cats ?? []).map((x) => [x.id, x.name]));
  const seller = trust?.get(c.sellerBusinessId);
  return (
    <>
      <PageHeader title={c.name} description={`Campaign ${c.id}`} />
      <AdsNav active="/ads/review" />
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-card border border-line bg-surface p-4 text-sm">
          <p className="text-xs uppercase text-muted">Seller</p>
          <p className="font-semibold text-ink">{seller?.name ?? c.sellerBusinessId}</p>
          <p>Tier {seller?.verificationTier ?? "?"} · trust {seller?.trustScore ?? "?"}{seller?.badgeActive ? " · badge" : ""}</p>
        </div>
        <div className="rounded-card border border-line bg-surface p-4 text-sm">
          <p className="text-xs uppercase text-muted">Budget</p>
          <p className="font-semibold text-ink">₹{(Number(c.dailyBudgetPaise) / 100).toLocaleString("en-IN")} per day{c.totalBudgetPaise ? `, ₹${(Number(c.totalBudgetPaise) / 100).toLocaleString("en-IN")} total` : ""}</p>
          <p>{fmtDate(c.startsAt)}{c.endsAt ? ` to ${fmtDate(c.endsAt)}` : " until paused"}</p>
        </div>
        <div className="rounded-card border border-line bg-surface p-4 text-sm">
          <p className="text-xs uppercase text-muted">Default price per click</p>
          <p className="font-semibold text-ink">{(rates ?? []).filter((r) => r.categoryId === null).map((r) => `${r.surface}: ₹${r.cpcPaise / 100}`).join(", ") || "not set"}</p>
          <p>Status <Badge tone={TONE[c.status] ?? "neutral"}>{c.status.replace("_", " ")}</Badge></p>
        </div>
      </div>
      {c.status === "pending_review" || c.adGroups.some((g) => g.status === "pending") ? null : <Alert tone="info">Nothing is pending on this campaign.</Alert>}

      {c.adGroups.map((g) => (
        <section key={g.id} className="space-y-3">
          <h2 className="flex flex-wrap items-center gap-2 text-base font-bold text-ink">{g.name} <Badge tone={TONE[g.status] ?? "neutral"}>{g.status}</Badge></h2>
          <p className="text-xs text-muted">
            Placements: {g.surfaces.join(", ")} · States: {g.states.join(", ") || "all"} · Pincode prefixes: {g.pincodePrefixes.join(", ") || "all"} · Categories: {g.categoryIds.map((x) => catName.get(x) ?? x).join(", ") || "any"}
          </p>
          <ItemReviewForm campaignId={c.id} subjectType="ad_group" subjectId={g.id} />
          <h3 className="text-sm font-semibold text-ink">Products</h3>
          <Table>
            <thead><tr><Th>Product</Th><Th>Category</Th><Th>Image</Th><Th>Status</Th><Th>Decision</Th></tr></thead>
            <tbody>
              {g.listings.map((l) => {
                const v = byId.get(l.listingId);
                return (
                  <tr key={l.id}>
                    <Td>{v?.title ?? <Mono>{l.listingId.slice(0, 8)}</Mono>}{v ? <span className="block text-xs text-muted">{v.status} / {v.moderationStatus}</span> : null}</Td>
                    <Td>{v?.category.name ?? ""}</Td>
                    <Td>{v?.imageUrls[0] ? <a href={v.imageUrls[0]} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-700 hover:underline">Open image</a> : <span className="text-danger">none</span>}</Td>
                    <Td><Badge tone={TONE[l.reviewStatus] ?? "neutral"}>{l.reviewStatus}</Badge>{l.reviewNote ? <span className="block text-xs text-muted">{l.reviewNote}</span> : null}</Td>
                    <Td><ItemReviewForm campaignId={c.id} subjectType="listing" subjectId={l.id} /></Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <h3 className="text-sm font-semibold text-ink">Keywords</h3>
          <Table>
            <thead><tr><Th>Keyword</Th><Th>Match</Th><Th>Negative</Th><Th>Status</Th><Th>Decision</Th></tr></thead>
            <tbody>
              {g.keywords.map((k) => (
                <tr key={k.id}>
                  <Td className="font-medium">{k.text}<span className="block text-xs text-muted">normalised: {k.normalised}</span></Td>
                  <Td>{k.matchType}</Td>
                  <Td>{k.negative ? "yes" : ""}</Td>
                  <Td><Badge tone={TONE[k.reviewStatus] ?? "neutral"}>{k.reviewStatus}</Badge>{k.reviewNote ? <span className="block text-xs text-muted">{k.reviewNote}</span> : null}</Td>
                  <Td><ItemReviewForm campaignId={c.id} subjectType="keyword" subjectId={k.id} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ))}

      <section aria-labelledby="decide" className="space-y-2">
        <h2 id="decide" className="text-base font-bold text-ink">Decide the campaign</h2>
        <p className="text-xs text-muted">Approving also approves everything still pending. Items you rejected stay rejected. Block trademark and competitor-brand keywords.</p>
        <DecideCampaignForm campaignId={c.id} />
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-bold text-ink">Review history</h2>
        <Table>
          <thead><tr><Th>When</Th><Th>Subject</Th><Th>Decision</Th><Th>Reason</Th><Th>Staff</Th></tr></thead>
          <tbody>{c.reviews.map((r) => <tr key={r.id}><Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td><Td>{r.subjectType}</Td><Td>{r.decision}</Td><Td>{r.reasonCode ?? ""} {r.note ?? ""}</Td><Td><Mono>{r.staffId.slice(0, 8)}</Mono></Td></tr>)}</tbody>
        </Table>
      </section>
    </>
  );
}
