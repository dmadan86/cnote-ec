import { a2aMetrics, adminListMandates, adminListNegotiations, isA2aEnabled, listAnomalies, listSuspensions } from "@cnote/a2a";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { FilterActions, FilterBar, FilterCheckbox, FilterField, FilterSelect, SectionNav } from "@/components/filters";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, json, one, safe, shortId } from "@/lib/util";
import { LiftForm, SuspendForm } from "./forms";

export const metadata = { title: "Agents" };

const MANDATE_STATUS = ["active", "paused", "revoked", "expired", "completed", "suspended"] as const;
const NEG_STATUS = ["open", "agreed", "accepted", "rejected", "withdrawn", "expired"] as const;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const pick =<T extends string>(v: string | undefined, all: readonly T[]): T | undefined => all.find((x) => x === v);
const rupees = (paise: number | null) => (paise == null ? "—" : `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`);
const pct = (r: number | null) => (r == null ? "—" : `${(r * 100).toFixed(1)}%`);
const num = (n: number | null) => (n == null ? "—" : String(Math.round(n * 10) / 10));

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold">{value}</dd>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { staff } = await requireStaff("/agents", "agents.read");
  const canSuspend = hasPrivilege(staff, "agents.suspend");
  const sp = await searchParams;
  const side = pick(one(sp.side), ["buyer", "seller"] as const);
  const mStatus = pick(one(sp.mstatus), MANDATE_STATUS);
  const nStatus = pick(one(sp.nstatus), NEG_STATUS);
  const flagged = one(sp.flagged) === "1";
  const since = daysAgo(30);
  const [metrics, mandates, negotiations, anomalies, suspensions] = await Promise.all([
    safe("a2a.metrics", () => a2aMetrics({ from: since })),
    safe("a2a.mandates", () => adminListMandates({ side, status: mStatus, limit: 100 })),
    safe("a2a.negotiations", () => adminListNegotiations({ status: nStatus, flagged, limit: 100 })),
    safe("a2a.anomalies", () => listAnomalies({ limit: 50 })),
    safe("a2a.suspensions", () => listSuspensions({ activeOnly: true, limit: 100 })),
  ]);
  return (
    <>
      <PageHeader title="Agents" description="Agent-to-agent commerce (ADR-020). Staff review behaviour and terms only: no party's private limits, floors or ceilings are shown anywhere in this console." />
      {!isA2aEnabled() ? <Alert tone="warning">A2A_ENABLED is off: agents do not run and the agent API returns 404. Existing records are shown read-only for review.</Alert> : null}
      <SectionNav items={[{ id: "mandates", label: "Mandates" }, { id: "negotiations", label: "Negotiations" }, { id: "anomalies", label: "Anomalies" }, { id: "suspensions", label: "Suspensions" }]} />

      <h2 className="mt-6 text-lg font-semibold">Last 30 days</h2>
      {metrics === null ? <Alert tone="warning">Metrics are currently unavailable.</Alert> : (
        <dl className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Agent-closed deals" value={String(metrics.agentClosedDeals)} hint={`of ${metrics.negotiations} negotiations`} />
          <Stat label="Auto-accept share" value={pct(metrics.autoAcceptShare)} hint="both sides auto-confirmed" />
          <Stat label="Median rounds to close" value={num(metrics.medianRoundsToClose)} />
          <Stat label="Human override rate" value={pct(metrics.humanOverrideRate)} hint={`${metrics.humanDeclined} of ${metrics.agreedByAgents} agreed`} />
          <Stat label="Flagged" value={String(metrics.flagged)} />
          <Stat label="External agent share" value={pct(metrics.externalShare)} />
        </dl>
      )}

      <h2 id="mandates" className="mt-8 text-lg font-semibold">Mandates</h2>
      <FilterBar label="Filter mandates">
        {nStatus ? <input type="hidden" name="nstatus" value={nStatus} /> : null}{flagged ? <input type="hidden" name="flagged" value="1" /> : null}
        <FilterField label="Side" width="sm"><FilterSelect name="side" defaultValue={side ?? ""}><option value="">All</option><option value="buyer">Buyer</option><option value="seller">Seller</option></FilterSelect></FilterField>
        <FilterField label="Status" width="md"><FilterSelect name="mstatus" defaultValue={mStatus ?? ""}><option value="">All</option>{MANDATE_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}</FilterSelect></FilterField>
        <FilterActions />
      </FilterBar>
      {mandates === null ? <Alert tone="warning">Unavailable.</Alert> : mandates.length === 0 ? <EmptyState title="No mandates match" /> : (
        <Table>
          <thead><tr><Th>Business</Th><Th>Mandate</Th><Th>Side</Th><Th>Status</Th><Th>Auto-accept</Th><Th>Recurrence</Th><Th>Expiry</Th>{canSuspend ? <Th>Suspend</Th> : null}</tr></thead>
          <tbody>
            {mandates.map((m) => (
              <tr key={m.id}>
                <Td>{m.businessName} <Mono>{shortId(m.businessId)}</Mono></Td>
                <Td>{m.name}{m.categorySlug ? ` (${m.categorySlug})` : ""} <Mono>{shortId(m.id)}</Mono></Td>
                <Td>{m.side}</Td>
                <Td><Badge tone={m.status === "active" ? "success" : m.status === "suspended" ? "danger" : "neutral"}>{m.status}</Badge></Td>
                <Td>{m.autoAccept ? "On" : "Off"}</Td>
                <Td>{m.recurrenceDays ? `every ${m.recurrenceDays}d` : "One-off"}</Td>
                <Td>{m.expiresAt ? fmtDate(m.expiresAt) : "None"}</Td>
                {canSuspend ? <Td>{m.status === "suspended" || m.status === "revoked" ? "—" : <SuspendForm fixed={{ kind: "mandate", targetId: m.id }} label="Suspend" />}</Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 id="negotiations" className="mt-8 text-lg font-semibold">Negotiations</h2>
      <FilterBar label="Filter negotiations">
        {side ? <input type="hidden" name="side" value={side} /> : null}{mStatus ? <input type="hidden" name="mstatus" value={mStatus} /> : null}
        <FilterField label="Status" width="md"><FilterSelect name="nstatus" defaultValue={nStatus ?? ""}><option value="">All</option>{NEG_STATUS.map((s) => <option key={s} value={s}>{s}</option>)}</FilterSelect></FilterField>
        <FilterCheckbox label="Flagged only" name="flagged" value="1" defaultChecked={flagged} />
        <FilterActions />
      </FilterBar>
      {negotiations === null ? <Alert tone="warning">Unavailable.</Alert> : negotiations.length === 0 ? <EmptyState title="No negotiations match" /> : (
        <Table>
          <thead><tr><Th>Negotiation</Th><Th>Status</Th><Th>Buyer</Th><Th>Seller</Th><Th>Round</Th><Th>Agreed price</Th><Th>External</Th><Th>Flagged</Th><Th>Created</Th></tr></thead>
          <tbody>
            {negotiations.map((n) => (
              <tr key={n.id}>
                <Td><Link className="font-medium text-brand-700 hover:underline" href={`/agents/negotiations/${n.id}`}>{shortId(n.id)}</Link></Td>
                <Td><Badge tone={n.status === "accepted" ? "success" : "neutral"}>{n.status}</Badge></Td>
                <Td>{n.buyer.name}</Td><Td>{n.seller.name}</Td>
                <Td>{n.round}/{n.maxRounds}</Td><Td>{rupees(n.agreedPricePaise)}</Td>
                <Td>{n.external ? "Yes" : "No"}</Td>
                <Td>{n.flagged ? <Badge tone="warning">Flagged</Badge> : "No"}</Td>
                <Td>{fmtDate(n.createdAt)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 id="anomalies" className="mt-8 text-lg font-semibold">Anomalies</h2>
      {anomalies === null ? <Alert tone="warning">Unavailable.</Alert> : anomalies.length === 0 ? <EmptyState title="No anomalies flagged" /> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Kind</Th><Th>Business</Th><Th>Negotiation</Th><Th>API key</Th><Th>Details</Th></tr></thead>
          <tbody>
            {anomalies.map((a) => (
              <tr key={a.id}>
                <Td>{fmtDate(a.createdAt)}</Td><Td>{a.kind.replaceAll("_", " ")}</Td><Td><Mono>{shortId(a.businessId)}</Mono></Td>
                <Td>{a.negotiationId ? <Link className="font-medium text-brand-700 hover:underline" href={`/agents/negotiations/${a.negotiationId}`}>{shortId(a.negotiationId)}</Link> : "—"}</Td>
                <Td>{a.apiKeyId ? <Mono>{a.apiKeyId}</Mono> : "—"}</Td>
                <Td><pre className="max-w-md whitespace-pre-wrap text-xs">{json(a.details, 600)}</pre></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <h2 id="suspensions" className="mt-8 text-lg font-semibold">Active suspensions</h2>
      {suspensions === null ? <Alert tone="warning">Unavailable.</Alert> : suspensions.length === 0 ? <EmptyState title="Nothing is suspended" /> : (
        <Table>
          <thead><tr><Th>Since</Th><Th>Kind</Th><Th>Target</Th><Th>Reason</Th><Th>By</Th>{canSuspend ? <Th>Lift</Th> : null}</tr></thead>
          <tbody>
            {suspensions.map((s) => (
              <tr key={s.id}>
                <Td>{fmtDate(s.createdAt)}</Td><Td>{s.kind.replace("_", " ")}</Td><Td><Mono>{s.targetId}</Mono></Td><Td>{s.reason}</Td><Td><Mono>{shortId(s.suspendedBy)}</Mono></Td>
                {canSuspend ? <Td><LiftForm id={s.id} /></Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {canSuspend ? (
        <>
          <h2 className="mt-8 text-lg font-semibold">Suspend by id</h2>
          <p className="mb-2 text-sm text-muted">Suspend a mandate, all agents of a business, or an external API key (by key id). Every action needs a reason and is written to the audit log.</p>
          <SuspendForm />
        </>
      ) : null}
    </>
  );
}
