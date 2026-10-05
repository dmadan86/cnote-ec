import type { ListingView } from "@cnote/catalogue";
import { getSellerSampleStats, sampleConfig, samplesEnabled } from "@/lib/samples";
import { formatPaise } from "@/features/pdp/tiers";
import { fill, sampleLabels } from "./labels";
import { RequestSampleDialog } from "./request-dialog";

/**
 * Product-page block: what the supplier offers as a sample (price, quantity cap, dispatch time, minimum buyer tier), the supplier's sample
 * approval rate once at least 5 samples were evaluated, and the request dialog. Renders nothing while SAMPLES_ENABLED is off or when the
 * listing does not offer samples. (The page is ISR: flipping the flag shows up at the next regeneration.)
 */
export async function SampleOffer({ listing, locale }: { listing: ListingView; locale: string }) {
  const tr = listing.trade ?? {};
  if (!samplesEnabled() || !tr.sampleAvailable) return null;
  const [l, stats] = await Promise.all([sampleLabels(locale), getSellerSampleStats([listing.sellerBusinessId]).catch(() => null)]);
  const s = stats?.get(listing.sellerBusinessId);
  const maxQty = tr.sampleMaxQty ?? sampleConfig().defaultMaxQty;
  const lines = [
    tr.samplePricePaise ? fill(l.offerPaid, { price: formatPaise(tr.samplePricePaise) }) : l.offerFree,
    fill(l.offerMax, { max: maxQty }),
    ...(tr.sampleDispatchDays != null ? [fill(l.offerDispatch, { days: tr.sampleDispatchDays })] : []),
    ...(tr.sampleMinBuyerTier ? [fill(l.offerTier, { tier: tr.sampleMinBuyerTier })] : []),
    ...(s && s.approvalRate !== null ? [fill(l.approvalRate, { pct: Math.round(s.approvalRate * 100), count: s.evaluated })] : []),
  ];
  return (
    <section aria-labelledby="sample-offer" data-testid="pdp-sample" className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
      <h2 id="sample-offer" className="text-base font-bold text-ink">{l.requestSample}</h2>
      <ul className="flex flex-col gap-1 text-sm text-muted">{lines.map((x) => <li key={x}>{x}</li>)}</ul>
      <div>
        <RequestSampleDialog labels={l} listingId={listing.id} title={listing.title} offerLines={lines} maxQty={maxQty} defaultQty={Math.min(maxQty, 1)} />
      </div>
    </section>
  );
}
