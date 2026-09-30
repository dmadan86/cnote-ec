import { getAdsConfig, getPublicRateCard } from "@cnote/ads";
import { listCategories } from "@cnote/catalogue";
import { Alert, PageHeader } from "@cnote/ui";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";
import { AdsNav } from "../ads-nav";
import { ConfigForm, RateCardForm } from "../forms";

export const metadata = { title: "Ad rate card and settings" };

export default async function AdSettings() {
  await requireStaff("/ads/settings", "ads.settings");
  const [cfg, rates, cats] = await Promise.all([safe("ads.config", () => getAdsConfig()), safe("ads.rates", () => getPublicRateCard()), safe("categories", () => listCategories())]);
  return (
    <>
      <PageHeader title="Rate card and settings" description="Fixed price per click by category (public), and the eligibility, placement and fraud knobs. Changes are versioned or audited and never need a deploy." />
      <AdsNav active="/ads/settings" />
      <section aria-labelledby="rc" className="space-y-3">
        <h2 id="rc" className="text-base font-bold text-ink">Rate card (shown publicly to sellers)</h2>
        <Alert tone="info">Each save adds a new version; old versions stay so we can always show what an advertiser was charged. A category rate covers its whole subtree; a placement with no rate cannot serve.</Alert>
        <RateCardForm categories={(cats ?? []).filter((c) => !c.prohibited).map((c) => ({ id: c.id, name: c.name }))} />
        {rates === null ? <Alert tone="warning">Rates are unavailable.</Alert> : (
          <Table>
            <thead><tr><Th>Category</Th><Th>Placement</Th><Th>Per click</Th><Th>Max</Th><Th>Effective from</Th></tr></thead>
            <tbody>{rates.map((r) => <tr key={`${r.categoryId}-${r.surface}`}><Td>{r.categoryName}</Td><Td>{r.surface}</Td><Td>₹{r.cpcPaise / 100}</Td><Td>{r.maxCpcPaise ? `₹${r.maxCpcPaise / 100}` : ""}</Td><Td className="whitespace-nowrap text-xs">{fmtDate(r.effectiveFrom)}</Td></tr>)}</tbody>
          </Table>
        )}
      </section>
      <section aria-labelledby="cfg" className="space-y-3">
        <h2 id="cfg" className="text-base font-bold text-ink">Settings</h2>
        {cfg === null ? <Alert tone="warning">Settings are unavailable.</Alert> : <ConfigForm values={cfg as unknown as Record<string, number>} />}
      </section>
    </>
  );
}
