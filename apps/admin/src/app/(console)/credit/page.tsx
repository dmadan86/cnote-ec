import { hasPrivilege } from "@cnote/admin";
import {
  COMPONENT_MAX, CREDIT_MODEL_VERSION, creditAttachedGmvShare, creditConfig, creditEnabled, creditStats, fldgExposure, getCreditPartner, listApplicationsForStaff, listLoansForStaff, partnerGnpa,
} from "@cnote/credit";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader, Stat, type BadgeTone } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { RefreshBookForm, RescoreForm } from "@/features/credit/forms";
import { inr } from "@/features/payments/format";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Credit" };
export const dynamic = "force-dynamic";

const VIEWS = ["overview", "applications", "loans"] as const;
const TONE: Record<string, BadgeTone> = { offered: "brand", accepted: "brand", disbursed: "success", rejected: "neutral", declined: "neutral", expired: "neutral", failed: "danger", cancelled: "neutral", submitted: "warning", active: "success", overdue: "danger", repaid: "neutral", written_off: "danger" };
const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
const DAY = 86_400_000;

export default async function CreditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const view = VIEWS.find((v) => v === one(sp.view)) ?? "overview";
  const { staff } = await requireStaff("/credit", "credit.read");
  const canManage = hasPrivilege(staff, "credit.manage");
  const tabs = VIEWS.map((v) => ({ href: v === "overview" ? "/credit" : `/credit?view=${v}`, label: v[0]!.toUpperCase() + v.slice(1), active: v === view }));
  return (
    <>
      <PageHeader title="Credit" description="Embedded credit via an NBFC partner (ADR-019). The partner is the lender of record; cnote lends nothing from its own balance sheet. Everything here is read-only except the audited actions marked below." />
      <LinkTabs label="View" items={tabs} />
      {!creditEnabled() ? <Alert tone="info">CREDIT_ENABLED is off. New scores and applications are refused; the existing loan book keeps updating from partner reports.</Alert> : null}
      {view === "overview" ? <Overview canManage={canManage} /> : view === "applications" ? <Applications status={one(sp.status)} /> : <Loans status={one(sp.status)} />}
    </>
  );
}

async function Overview({ canManage }: { canManage: boolean }) {
  const now = new Date();
  const range = { from: new Date(now.getTime() - 30 * DAY), to: now };
  const [gnpa, stats, attached, fldg] = await Promise.all([
    safe("credit.gnpa", partnerGnpa), safe("credit.stats", () => creditStats(range)), safe("credit.attached", () => creditAttachedGmvShare(range)), safe("credit.fldg", fldgExposure),
  ]);
  const cfg = creditConfig();
  let partnerName = "unknown";
  try { partnerName = getCreditPartner().name; } catch { /* misconfigured CREDIT_PARTNER */ }
  return (
    <div className="space-y-6">
      <section aria-labelledby="book-h" className="space-y-3">
        <h2 id="book-h" className="text-lg font-semibold">Partner book health</h2>
        {stats === null ? <Alert tone="warning">Credit data is currently unavailable.</Alert> : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Applications (30d)" value={stats.applications} hint={`${stats.offered} offered, ${stats.accepted} accepted, ${stats.rejected} rejected`} />
            <Stat label="Disbursed (30d)" value={inr(stats.disbursedPaise)} hint={`${stats.disbursedLoans} loans`} />
            <Stat label="Outstanding book" value={inr(stats.outstandingPaise)} hint={`${stats.overdueLoans} overdue loans`} />
            <Stat label="Credit-attached GMV (30d)" value={attached ? pct(attached.share) : "n/a"} hint={attached ? `target ${pct(attached.targetShare)} of escrowed GMV${attached.meetsTarget ? " (met)" : ""}` : undefined} />
          </div>
        )}
        {gnpa === null ? null : gnpa.length === 0 ? <EmptyState title="No loans yet" description="Partner GNPA appears once loans are disbursed." /> : (
          <Table>
            <thead><tr><Th>Partner</Th><Th>Open loans</Th><Th>Book</Th><Th>Gross NPA</Th><Th>GNPA ratio</Th><Th>Target</Th><Th>Status</Th></tr></thead>
            <tbody>
              {gnpa.map((g) => (
                <tr key={g.partner}>
                  <Td>{g.partner}</Td><Td>{g.loans}</Td><Td className="tabular-nums">{inr(g.bookPaise)}</Td><Td className="tabular-nums">{inr(g.gnpaPaise)}</Td>
                  <Td className="tabular-nums">{pct(g.gnpaRatio)}</Td><Td>below {pct(g.targetRatio)}</Td>
                  <Td><Badge tone={g.withinTarget ? "success" : "danger"}>{g.withinTarget ? "within target" : "above target"}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="fldg-h" className="space-y-3">
        <h2 id="fldg-h" className="text-lg font-semibold">First-loss guarantee (FLDG) exposure</h2>
        <p className="text-sm text-muted">Cap is {(cfg.fldgCapBps / 100).toFixed(2)}% of the originated book. Exposure = what the guarantee could be called for (loans 90+ days past due plus write-offs), capped. This view never triggers a payment.</p>
        {fldg === null ? <Alert tone="warning">FLDG data is currently unavailable.</Alert> : fldg.length === 0 ? <EmptyState title="No exposure" description="Nothing originated yet." /> : (
          <Table>
            <thead><tr><Th>Partner</Th><Th>Originated</Th><Th>Cap</Th><Th>Defaulted</Th><Th>Exposure</Th><Th>Headroom</Th><Th>Utilisation</Th></tr></thead>
            <tbody>
              {fldg.map((f) => (
                <tr key={f.partner}>
                  <Td>{f.partner}</Td><Td className="tabular-nums">{inr(f.originatedPaise)}</Td><Td className="tabular-nums">{inr(f.capPaise)}</Td><Td className="tabular-nums">{inr(f.defaultedPaise)}</Td>
                  <Td className="tabular-nums">{inr(f.exposurePaise)}</Td><Td className="tabular-nums">{inr(f.headroomPaise)}</Td><Td>{pct(f.utilisation)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="model-h" className="space-y-3">
        <h2 id="model-h" className="text-lg font-semibold">Score model</h2>
        <p className="text-sm">Active model <Mono>{CREDIT_MODEL_VERSION}</Mono>, partner adapter <Mono>{partnerName}</Mono>. Score is 300 plus up to 600 points from these components, deterministic and explainable (reason codes are stored with every snapshot).</p>
        <Table>
          <thead><tr><Th>Reason code</Th><Th>Max points</Th></tr></thead>
          <tbody>{Object.entries(COMPONENT_MAX).map(([code, max]) => <tr key={code}><Td><Mono>{code}</Mono></Td><Td>{max}</Td></tr>)}</tbody>
        </Table>
      </section>

      {canManage ? (
        <section aria-labelledby="ops-h" className="space-y-3">
          <h2 id="ops-h" className="text-lg font-semibold">Operations (audited)</h2>
          <RefreshBookForm />
          <RescoreForm />
        </section>
      ) : null}
    </div>
  );
}

async function Applications({ status }: { status?: string }) {
  const rows = await safe("credit.applications", () => listApplicationsForStaff({ status, limit: 100 }));
  return rows === null ? <Alert tone="warning">Credit data is currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No applications" description="Nothing matches this filter." /> : (
    <Table>
      <thead><tr><Th>Application</Th><Th>Created</Th><Th>Product</Th><Th>Business</Th><Th>Order</Th><Th>Amount</Th><Th>Score</Th><Th>Partner</Th><Th>Status</Th></tr></thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id}>
            <Td><Mono>{shortId(a.id)}</Mono></Td><Td className="whitespace-nowrap">{fmtDate(a.createdAt)}</Td><Td>{a.product.replace("_", " ")}</Td>
            <Td><Link href={`/businesses/${a.businessId}`}><Mono>{shortId(a.businessId)}</Mono></Link></Td><Td><Mono>{shortId(a.orderId)}</Mono></Td>
            <Td className="tabular-nums">{inr(a.amountPaise)}</Td><Td>{a.score ?? "-"}{a.scoreBand ? ` (${a.scoreBand.replace("_", " ")})` : ""}</Td><Td>{a.partner}</Td>
            <Td><Badge tone={TONE[a.status] ?? "neutral"}>{a.status}</Badge>{a.reason ? <span className="ml-1 text-xs text-muted">{a.reason}</span> : null}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

async function Loans({ status }: { status?: string }) {
  const rows = await safe("credit.loans", () => listLoansForStaff({ status, limit: 100 }));
  return rows === null ? <Alert tone="warning">Credit data is currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No loans" description="Nothing matches this filter." /> : (
    <Table>
      <thead><tr><Th>Loan</Th><Th>Disbursed</Th><Th>Product</Th><Th>Business</Th><Th>Principal</Th><Th>Repaid</Th><Th>Outstanding</Th><Th>Due</Th><Th>DPD</Th><Th>Status</Th></tr></thead>
      <tbody>
        {rows.map((l) => (
          <tr key={l.id}>
            <Td><Mono>{shortId(l.id)}</Mono></Td><Td className="whitespace-nowrap">{fmtDate(l.disbursedAt)}</Td><Td>{l.product.replace("_", " ")}</Td>
            <Td><Link href={`/businesses/${l.businessId}`}><Mono>{shortId(l.businessId)}</Mono></Link></Td><Td className="tabular-nums">{inr(l.principalPaise)}</Td>
            <Td className="tabular-nums">{inr(l.repaidPaise)}</Td><Td className="tabular-nums">{inr(l.outstandingPaise)}</Td><Td className="whitespace-nowrap">{fmtDate(l.dueAt)}</Td><Td>{l.dpd}</Td>
            <Td><Badge tone={TONE[l.status] ?? "neutral"}>{l.status.replace("_", " ")}</Badge></Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
