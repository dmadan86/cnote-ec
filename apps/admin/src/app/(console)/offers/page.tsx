import { listHonourReports, listOffersForReview } from "@cnote/promotions";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import { Mono, Table, Td, Th } from "@/components/table";
import { HonourDecisionForm, OfferReviewForm, SuspendOfferForm } from "@/features/promotions/review-forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Offers" };
const inr = (p: number | null) => (p == null ? "none" : `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const FLAG: Record<string, string> = { deep_discount: "Deep discount (> 50%)", below_floor: "Below price floor", prior_honour_complaint: "Seller has upheld honour reports" };

function summary(kind: string, terms: unknown): string {
  const t = terms as { unitPricePaise?: number; tiers?: { minQty: number; unitPricePaise: number }[]; minQty?: number; minOrderValuePaise?: number; regions?: string[] };
  if (kind === "timed_price") return `${inr(t.unitPricePaise ?? 0)} per unit`;
  if (kind === "volume_tiers") return (t.tiers ?? []).map((x) => `${x.minQty}+ at ${inr(x.unitPricePaise)}`).join(", ");
  return [t.minQty ? `${t.minQty}+ units` : null, t.minOrderValuePaise ? `above ${inr(t.minOrderValuePaise)}` : null, (t.regions ?? []).join("/") || "all India"].filter(Boolean).join(", ");
}

export default async function OffersPage({ searchParams }: PageProps<"/offers">) {
  const sp = await searchParams;
  const tab = one(sp.tab) === "reports" ? "reports" : one(sp.tab) === "live" ? "live" : "review";
  await requireStaff("/offers", "offers.review");
  const review = await safe("offers.review", () => listOffersForReview({ status: "needs_review" }));
  const live = tab === "live" ? await safe("offers.live", () => listOffersForReview({ status: "active" })) : null;
  const reports = tab === "reports" ? await safe("offers.reports", () => listHonourReports({ status: "open" })) : null;
  return (
    <>
      <PageHeader title="Seller offers" description="Offers held for a flag, live offers, and buyer reports that a seller did not honour an offer. Reference prices are computed by the platform from price history; nothing here lets staff or sellers type one." />
      <LinkTabs label="View" items={[
        { href: "/offers", label: `Held for review${review ? ` (${review.length})` : ""}`, active: tab === "review" },
        { href: "/offers?tab=reports", label: "Honour reports", active: tab === "reports" },
        { href: "/offers?tab=live", label: "Live offers", active: tab === "live" },
      ]} />

      {tab === "review" ? (review === null ? <Alert tone="warning">Offers are currently unavailable.</Alert> : review.length === 0 ? <EmptyState title="Nothing to review" description="Clean offers are approved automatically." /> : (
        <Table>
          <thead><tr><Th>Listing</Th><Th>Offer</Th><Th>Flags</Th><Th>When</Th><Th>Decision</Th></tr></thead>
          <tbody>{review.map((o) => (
            <tr key={o.id}>
              <Td><p className="font-medium">{o.listingTitle ?? "Listing"}</p><Mono>{shortId(o.listingId)}</Mono> <span className="text-xs text-muted">seller {shortId(o.sellerBusinessId)}</span></Td>
              <Td><p>{o.kind.replace(/_/g, " ")}</p><p className="text-xs text-muted">{summary(o.kind, o.terms)}</p></Td>
              <Td><ul className="space-y-1">{o.reviewFlags.map((f) => <li key={f}><Badge tone="warning">{FLAG[f] ?? f}</Badge></li>)}</ul></Td>
              <Td className="whitespace-nowrap text-xs">{fmtDate(o.startsAt)}{o.endsAt ? <><br />to {fmtDate(o.endsAt)}</> : null}</Td>
              <Td className="min-w-64"><OfferReviewForm id={o.id} /></Td>
            </tr>
          ))}</tbody>
        </Table>
      )) : null}

      {tab === "live" ? (live === null ? <Alert tone="warning">Offers are currently unavailable.</Alert> : live.length === 0 ? <EmptyState title="No live offers" description="Nothing is running right now." /> : (
        <Table>
          <thead><tr><Th>Listing</Th><Th>Offer</Th><Th>Platform reference (30-day low)</Th><Th>Ends</Th><Th>Action</Th></tr></thead>
          <tbody>{live.map((o) => (
            <tr key={o.id}>
              <Td><p className="font-medium">{o.listingTitle ?? "Listing"}</p><Mono>{shortId(o.listingId)}</Mono></Td>
              <Td><p>{o.kind.replace(/_/g, " ")}</p><p className="text-xs text-muted">{summary(o.kind, o.terms)}</p></Td>
              <Td>{o.kind === "free_delivery_moq" ? "n/a" : o.referencePricePaise ? `${inr(o.referencePricePaise)}${o.discountBps ? ` (${Math.floor(o.discountBps / 100)}% below)` : ""}` : "None: under 30 days of history, buyers see the offer price only"}</Td>
              <Td className="whitespace-nowrap text-xs">{o.endsAt ? fmtDate(o.endsAt) : "until cancelled"}</Td>
              <Td><SuspendOfferForm id={o.id} /></Td>
            </tr>
          ))}</tbody>
        </Table>
      )) : null}

      {tab === "reports" ? (reports === null ? <Alert tone="warning">Reports are currently unavailable.</Alert> : reports.length === 0 ? <EmptyState title="No open reports" description="Buyer reports of offers that were not honoured appear here." /> : (
        <Table>
          <thead><tr><Th>Offer</Th><Th>Buyer note</Th><Th>Filed</Th><Th>Decision</Th></tr></thead>
          <tbody>{reports.map((r) => (
            <tr key={r.id}>
              <Td><p className="font-medium">{r.listingTitle ?? "Listing"}</p><p className="text-xs text-muted">{r.offerKind.replace(/_/g, " ")} · seller <Mono>{shortId(r.sellerBusinessId)}</Mono></p></Td>
              <Td className="max-w-sm whitespace-pre-wrap text-xs">{r.note ?? "No note"}{r.enquiryId ? <><br />Enquiry <Mono>{shortId(r.enquiryId)}</Mono></> : null}</Td>
              <Td className="whitespace-nowrap text-xs">{fmtDate(r.createdAt)}</Td>
              <Td><HonourDecisionForm id={r.id} /></Td>
            </tr>
          ))}</tbody>
        </Table>
      )) : null}
    </>
  );
}
