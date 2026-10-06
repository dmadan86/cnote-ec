import { estimateWithCard, getActiveRateCard, listRateCards, providerName, type FreightEstimate } from "@cnote/logistics";
import { Alert, Badge, EmptyState, PageHeader, Stat } from "@cnote/ui";
import { FilterActions, FilterBar, FilterField, FilterInput } from "@/components/filters";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";
import { ActivateForm, RateCardForm, ResetForm } from "./forms";

export const metadata = { title: "Freight estimator" };
export const dynamic = "force-dynamic";

const inr = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(paise / 100);
const PIN = /^[1-9]\d{5}$/;

export default async function FreightPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  await requireStaff("/freight", "logistics.manage");
  const [card, versions] = await Promise.all([safe("freight.card", () => getActiveRateCard()), safe("freight.versions", () => listRateCards(20))]);
  const active = versions?.find((v) => v.isActive) ?? null;

  // Rate-card tester: pure computation with the card in force (no live carrier call), so staff can sanity-check an edit.
  const o = one(sp.origin) ?? "";
  const d = one(sp.dest) ?? "";
  const qty = Math.max(1, Math.floor(Number(one(sp.qty) ?? "1")) || 1);
  const grams = Math.floor(Number(one(sp.grams) ?? "")) || null;
  const test: FreightEstimate | null = card && PIN.test(o) && PIN.test(d) ? estimateWithCard({ originPincode: o, destinationPincode: d, quantity: qty, unitWeightGrams: grams }, card) : null;

  return (
    <>
      <PageHeader title="Freight estimator" description="Estimate-only freight (the platform never books or owns logistics). The heuristic rate card below prices parcel, part-truck and full-truck lanes by zone and weight slab. Live Shiprocket / Delhivery rates are chosen with FREIGHT_PROVIDER and fall back to this card." />
      {card === null ? <Alert tone="warning">The rate card is currently unavailable.</Alert> : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Provider" value={providerName()} hint="FREIGHT_PROVIDER" />
          <Stat label="Active card" value={active ? `v${active.version}` : "Built-in default"} hint={active ? fmtDate(active.createdAt) : undefined} />
          <Stat label="Fuel surcharge" value={`${card.fuelSurchargeBps / 100}%`} />
          <Stat label="GST on freight" value={`${card.gstBps / 100}%`} />
        </div>
      )}

      <section aria-labelledby="test-heading" className="space-y-2">
        <h2 id="test-heading" className="text-base font-semibold">Try the active card</h2>
        <FilterBar label="Test a lane">
          <FilterField label="Origin PIN" width="sm"><FilterInput name="origin" defaultValue={o} inputMode="numeric" maxLength={6} /></FilterField>
          <FilterField label="Destination PIN" width="sm"><FilterInput name="dest" defaultValue={d} inputMode="numeric" maxLength={6} /></FilterField>
          <FilterField label="Quantity" width="xs"><FilterInput name="qty" defaultValue={String(qty)} inputMode="numeric" /></FilterField>
          <FilterField label="Unit weight (g)" width="xs"><FilterInput name="grams" defaultValue={grams ? String(grams) : ""} inputMode="numeric" /></FilterField>
          <FilterActions submitLabel="Estimate" clearHref="/freight" />
        </FilterBar>
        {test ? (
          <Alert tone="info">
            {test.mode} / {test.zone}: {inr(test.lowPaise)} to {inr(test.highPaise)} before GST (mid {inr(test.midPaise)}), {test.transitDays.min} to {test.transitDays.max} days, chargeable {test.chargeableWeightKg} kg
            {test.assumptions.length ? `. Assumptions: ${test.assumptions.join(", ")}` : ""}
          </Alert>
        ) : null}
      </section>

      <section aria-labelledby="edit-heading" className="space-y-2">
        <h2 id="edit-heading" className="text-base font-semibold">Edit rate card</h2>
        {card ? <RateCardForm json={JSON.stringify(card, null, 2)} /> : null}
        <ResetForm />
      </section>

      <section aria-labelledby="versions-heading" className="space-y-2">
        <h2 id="versions-heading" className="text-base font-semibold">Versions</h2>
        {versions === null ? <Alert tone="warning">Versions are unavailable.</Alert> : versions.length === 0 ? <EmptyState title="No saved versions" description="The built-in default card is in force until the first save." /> : (
          <Table>
            <thead><tr><Th>Version</Th><Th>Saved</Th><Th>Note</Th><Th>Status</Th><Th>Action</Th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <Td>v{v.version}</Td><Td className="whitespace-nowrap">{fmtDate(v.createdAt)}</Td><Td>{v.note ?? ""}</Td>
                  <Td>{v.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</Td>
                  <Td>{v.isActive ? null : <ActivateForm version={v.version} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
