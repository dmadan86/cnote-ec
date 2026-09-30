import type { Metadata } from "next";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, Money, PageHeader, type BadgeTone } from "@cnote/ui";
import { referencePrice } from "@cnote/catalogue";
import { listSellerOffers, offerPrivilegesSuspended, type OfferView } from "@cnote/promotions";
import { requireSeller } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { CancelOfferButton } from "@/features/offers/cancel-button";
import { OfferForm, type ListingChoice } from "@/features/offers/offer-form";

export const metadata: Metadata = { title: "Offers" };

const KIND = { timed_price: "Limited-time price", volume_tiers: "Volume pricing", free_delivery_moq: "Free delivery" } as const;
const STATUS: Record<OfferView["status"], { label: string; tone: BadgeTone }> = {
  draft: { label: "Scheduled", tone: "brand" },
  needs_review: { label: "With our team", tone: "warning" },
  active: { label: "Live", tone: "success" },
  rejected: { label: "Not approved", tone: "danger" },
  expired: { label: "Ended", tone: "neutral" },
  cancelled: { label: "Ended by you", tone: "neutral" },
  suspended: { label: "Paused", tone: "danger" },
};
const FLAG: Record<string, string> = { deep_discount: "large discount", below_floor: "very low price", prior_honour_complaint: "earlier buyer report" };
const ENDED: Record<string, string> = { listing_changed: "the listing changed", suspended: "paused by our team", expired: "it reached its end date", cancelled: "you ended it" };

function terms(o: OfferView): string {
  const t = o.terms as { unitPricePaise?: number; tiers?: { minQty: number; unitPricePaise: number }[]; minQty?: number; minOrderValuePaise?: number; regions?: string[] };
  const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  if (o.kind === "timed_price") return `${inr(t.unitPricePaise ?? 0)} per unit`;
  if (o.kind === "volume_tiers") return (t.tiers ?? []).map((x) => `${x.minQty}+ at ${inr(x.unitPricePaise)}`).join(" · ");
  return [t.minQty ? `${t.minQty}+ units` : null, t.minOrderValuePaise ? `orders above ${inr(t.minOrderValuePaise)}` : null, t.regions?.length ? t.regions.join(", ") : "all of India"].filter(Boolean).join(" · ");
}

export default async function OffersPage() {
  const session = await requireSeller("/offers");
  const id = session.business.id;
  const [offers, listings, paused] = await Promise.all([
    load(() => listSellerOffers(id)),
    load(async () => {
      const live = (await catalogue.listSellerListings(id)).filter((l) => l.status === "published" && l.moderationStatus === "approved" && l.pricePaise);
      return Promise.all(live.map(async (l): Promise<ListingChoice> => ({ id: l.id, title: l.title, pricePaise: l.pricePaise, moq: l.moq, referencePaise: await referencePrice(l.id).catch(() => null) })));
    }),
    load(() => offerPrivilegesSuspended(id)),
  ]);

  return (
    <div className="space-y-8">
      <PageHeader title="Offers" description="Volume pricing, limited-time prices and free delivery on your live listings. Honest by design: buyers only ever see a real 30-day comparison." />

      <Alert tone="info">
        <strong>How the comparison price works.</strong> If your offer is below the lowest price your listing had in the last 30 days, buyers see that price struck through, labelled as such, with the percentage rounded down. We work it out from your price history, so raising a price before a sale does not create a bigger discount. Offers end exactly when they say they do.
      </Alert>
      {paused.ok && paused.data ? <Alert tone="danger">Offers are paused on your account after buyer reports that were upheld. Contact support to have this reviewed.</Alert> : null}

      <Card>
        <CardHeader><CardTitle>Create an offer</CardTitle></CardHeader>
        <CardBody>
          {listings.ok ? <OfferForm listings={listings.data} /> : <Alert tone="danger">{listings.error}</Alert>}
        </CardBody>
      </Card>

      <section aria-labelledby="your-offers" className="space-y-3">
        <h2 id="your-offers" className="text-lg font-bold text-ink">Your offers</h2>
        {!offers.ok ? <Alert tone="danger">{offers.error}</Alert> : offers.data.length === 0 ? (
          <EmptyState title="No offers yet" description="Create your first offer above. Offers help buyers choose you at larger quantities." />
        ) : (
          <ul className="space-y-3">
            {offers.data.map((o) => {
              const s = STATUS[o.status];
              const open = o.status === "active" || o.status === "draft" || o.status === "needs_review";
              return (
                <li key={o.id}>
                  <Card>
                    <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 space-y-1">
                        <p className="truncate font-semibold text-ink">{o.listingTitle ?? "Listing"}</p>
                        <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
                          <Badge tone={s.tone}>{s.label}</Badge> {KIND[o.kind]}
                        </p>
                        <p className="text-sm text-ink">{terms(o)}</p>
                        <p className="text-xs text-muted">
                          {formatDateTime(o.startsAt)}{o.endsAt ? ` to ${formatDateTime(o.endsAt)}` : ", until you end it"}
                        </p>
                        {o.status === "active" && o.kind !== "free_delivery_moq" ? (
                          <p className="text-xs text-muted">
                            {o.referencePricePaise ? <>Buyers see <Money paise={o.referencePricePaise} /> struck through{o.discountBps ? `, ${Math.floor(o.discountBps / 100)}% below` : ""}, the lowest price of the last 30 days.</> : "Buyers see your offer price only (not enough price history for a comparison)."}
                          </p>
                        ) : null}
                        {o.status === "needs_review" ? <p className="text-xs text-warning">Held for a quick check: {o.reviewFlags.map((f) => FLAG[f] ?? f).join(", ")}.</p> : null}
                        {o.reviewNote && (o.status === "rejected" || o.status === "suspended") ? <p className="text-xs text-danger">Note from our team: {o.reviewNote}</p> : null}
                        {o.endedReason && (o.status === "suspended" || o.status === "rejected") ? <p className="text-xs text-muted">Ended because {ENDED[o.endedReason] ?? o.endedReason}.</p> : null}
                      </div>
                      {open ? <CancelOfferButton offerId={o.id} title={o.listingTitle ?? "listing"} /> : null}
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
