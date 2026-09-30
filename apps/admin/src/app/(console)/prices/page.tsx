import { adminSummary, listCells, listRuns } from "@cnote/prices";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader, Stat } from "@cnote/ui";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";
import { KForm, RepublishForm, RunNowForm, UnpublishForm } from "./forms";

export const metadata = { title: "Price intelligence" };
export const dynamic = "force-dynamic";

const inr = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(paise / 100);

export default async function PricesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const view = one(sp.view) === "unpublished" ? "unpublished" : "published";
  await requireStaff("/prices", "prices.manage");
  const [summary, runs, cells] = await Promise.all([
    safe("prices.summary", () => adminSummary()),
    safe("prices.runs", () => listRuns(15)),
    safe("prices.cells", () => listCells({ status: view, limit: 100 })),
  ]);
  return (
    <>
      <PageHeader title="Price intelligence" description="Anonymised category price benchmarks (ADR-022). A cell is published only with at least k distinct sellers and k distinct buyers and no seller above half the samples. No business is ever identifiable here." />
      {summary === null ? <Alert tone="warning">Price intelligence data is currently unavailable.</Alert> : (
        <>
          {!summary.enabled ? <Alert tone="info">PRICE_INTEL_ENABLED is off: buyers and sellers do not see benchmarks. Staff runs still work.</Alert> : null}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="k threshold" value={summary.k} />
            <Stat label="Published cells" value={summary.publishedCells} hint={`${summary.unpublishedCells} manually unpublished`} />
            <Stat label="Latest run" value={summary.latest ? `${summary.latest.cells} published` : "None yet"} hint={summary.latest ? fmtDate(summary.latest.startedAt) : undefined} />
            <Stat label="Suppression rate" value={summary.suppressionRate === null ? "-" : `${Math.round(summary.suppressionRate * 100)}%`} hint={summary.latest ? `${summary.latest.suppressedReasons.sellers} few sellers, ${summary.latest.suppressedReasons.buyers} few buyers, ${summary.latest.suppressedReasons.dominance} dominant seller` : undefined} />
          </div>
          <section aria-labelledby="k-heading" className="space-y-2">
            <h2 id="k-heading" className="text-base font-semibold">k-anonymity threshold</h2>
            <KForm k={summary.k} />
          </section>
        </>
      )}
      <section aria-labelledby="runs-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="runs-heading" className="text-base font-semibold">Publication runs</h2><RunNowForm /></div>
        {runs === null ? <Alert tone="warning">Runs are unavailable.</Alert> : runs.length === 0 ? <EmptyState title="No runs yet" description="The nightly job or a manual run creates the first one." /> : (
          <Table>
            <thead><tr><Th>Started</Th><Th>Period</Th><Th>Trigger</Th><Th>Status</Th><Th>k</Th><Th>Samples</Th><Th>Published</Th><Th>Suppressed</Th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{fmtDate(r.startedAt)}</Td><Td>{r.period}</Td><Td>{r.trigger}</Td>
                  <Td><Badge tone={r.status === "completed" ? "success" : r.status === "failed" ? "danger" : "warning"}>{r.status}</Badge>{r.error ? <span className="ml-2 text-xs text-muted">{r.error}</span> : null}</Td>
                  <Td>{r.k}</Td><Td className="tabular-nums">{r.samples}</Td><Td className="tabular-nums">{r.cells}</Td>
                  <Td className="tabular-nums">{r.suppressedCells} <span className="text-xs text-muted">({r.suppressedReasons.sellers}/{r.suppressedReasons.buyers}/{r.suppressedReasons.dominance})</span></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
      <section aria-labelledby="cells-heading" className="space-y-2">
        <h2 id="cells-heading" className="text-base font-semibold">Benchmark cells</h2>
        <LinkTabs label="Cell status" items={[{ href: "/prices", label: "Published", active: view === "published" }, { href: "/prices?view=unpublished", label: "Unpublished", active: view === "unpublished" }]} />
        {cells === null ? <Alert tone="warning">Cells are unavailable.</Alert> : cells.length === 0 ? <EmptyState title="No cells" description="Nothing matches this filter." /> : (
          <Table>
            <thead><tr><Th>Period</Th><Th>Category</Th><Th>Region</Th><Th>Volume</Th><Th>Unit</Th><Th>p25 / median / p75</Th><Th>Samples</Th><Th>Sellers / buyers</Th><Th>Action</Th></tr></thead>
            <tbody>
              {cells.map((c) => (
                <tr key={c.id}>
                  <Td>{c.period}</Td><Td>{c.categoryName}</Td><Td>{c.regionLabel}</Td><Td>{c.tier === "all" ? "All" : c.tier.toUpperCase()}</Td><Td><Mono>{c.unit}</Mono></Td>
                  <Td className="whitespace-nowrap tabular-nums">{inr(c.p25Paise)} / {inr(c.medianPaise)} / {inr(c.p75Paise)}</Td>
                  <Td className="tabular-nums">{c.sampleCount}</Td><Td className="tabular-nums">{c.sellerCount} / {c.buyerCount}</Td>
                  <Td>{c.status === "published" ? <UnpublishForm cellId={c.id} /> : <div className="space-y-1"><p className="text-xs text-muted">{c.unpublishedReason}</p><RepublishForm cellId={c.id} /></div>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
