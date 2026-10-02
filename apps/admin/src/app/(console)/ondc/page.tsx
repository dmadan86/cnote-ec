import { hasPrivilege } from "@cnote/admin";
import { adminOverview, listFailedCallbacks, listIssues, listMessages, ondcEvaluation, readiness } from "@/lib/ondc";
import { Alert, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, json, one, safe } from "@/lib/util";
import { CertItemForm, KillSwitchForm, ReplayButton, ResolveIssueForm } from "./buttons";

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

export const metadata = { title: "ONDC" };

export default async function OndcPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { staff } = await requireStaff("/ondc", "ondc.manage");
  const sp = await searchParams;
  const direction = one(sp.direction) === "inbound" ? "inbound" : one(sp.direction) === "outbound" ? "outbound" : undefined;
  const canAct = hasPrivilege(staff, "ondc.manage");
  const since = daysAgo(90);
  const [ready, issues, evaluation] = await Promise.all([
    safe("ondc.readiness", () => readiness()),
    safe("ondc.issues", () => listIssues({ limit: 50 })),
    safe("ondc.evaluation", () => ondcEvaluation(since, daysAgo(-1))),
  ]);
  const [overview, failed, log] = await Promise.all([
    safe("ondc.overview", () => adminOverview()),
    safe("ondc.failed", () => listFailedCallbacks(50)),
    safe("ondc.messages", () => listMessages({ direction, limit: 50 })),
  ]);
  const c = overview?.config;
  return (
    <>
      <PageHeader title="ONDC adapter" description="Seller-network-participant adapter (ADR-017). Secrets are never shown here: only whether each key is configured. Message bodies are redacted (buyer contact and billing removed)." />
      {c === undefined ? <Alert tone="warning">Adapter status is currently unavailable.</Alert> : (
        <>
          <Alert tone={c.enabled ? "success" : "info"}>{c.enabled ? "ONDC_ENABLED is on: the adapter answers network requests." : "ONDC_ENABLED is off: routes return 404 and nothing is published."}</Alert>
          <Table>
            <tbody>
              <tr><Th>Environment</Th><Td>{c.env} <Mono>{c.registryUrl}</Mono></Td></tr>
              <tr><Th>Subscriber</Th><Td>{c.subscriberId ?? "not set"} {c.uniqueKeyId ? <Mono>{c.uniqueKeyId}</Mono> : null}</Td></tr>
              <tr><Th>Subscriber URL</Th><Td>{c.subscriberUrl ?? "not set"}</Td></tr>
              <tr><Th>Domains / cities</Th><Td>{c.domains.join(", ")} / {c.cityCodes.join(", ")}</Td></tr>
              <tr><Th>Signing key</Th><Td>{c.signingKey}</Td></tr>
              <tr><Th>Encryption key</Th><Td>{c.encryptionKey}</Td></tr>
              <tr><Th>Ready</Th><Td>{c.ready ? "Yes" : `No. Missing: ${c.missing.join(", ") || "valid signing key"}`}</Td></tr>
              <tr><Th>Connected sellers</Th><Td>{overview?.connectedSellers} ({overview?.optedInListings} listings opted in)</Td></tr>
              <tr><Th>Orders</Th><Td>{overview?.orders.total} total, {overview?.orders.created} awaiting a seller decision</Td></tr>
            </tbody>
          </Table>
        </>
      )}
      <h2 className="mt-6 text-lg font-semibold">Kill switch</h2>
      {ready === null ? <Alert tone="warning">Unavailable.</Alert> : (
        <>
          <Alert tone={ready.killSwitch.killed ? "danger" : "info"}>
            {ready.killSwitch.killed ? `ONDC is SUSPENDED: inbound requests are NACKed and nothing is published.${ready.killSwitch.note ? ` Reason: ${ready.killSwitch.note}.` : ""}` : "ONDC traffic is flowing. Suspending needs no redeploy and is recorded in the audit log."}
          </Alert>
          {canAct ? <div className="mt-2"><KillSwitchForm killed={ready.killSwitch.killed} /></div> : null}
          <h2 className="mt-6 text-lg font-semibold">Go-live readiness (ADR-021)</h2>
          <Alert tone={ready.goLive ? "success" : "warning"}>{ready.goLive ? "All automatic checks and certification items are complete." : `Not ready: automatic checks ${ready.autoOk ? "pass" : "have gaps"}, certification items ${ready.manualOk ? "complete" : "incomplete"}.`}</Alert>
          <Table>
            <thead><tr><Th>Check</Th><Th>Status</Th><Th>Detail</Th>{canAct ? <Th /> : null}</tr></thead>
            <tbody>
              {ready.items.map((i) => (
                <tr key={i.id}>
                  <Td>{i.label}{i.kind === "manual" ? " (manual)" : ""}</Td><Td>{i.ok ? "Done" : "Open"}</Td><Td>{i.detail ?? "—"}</Td>
                  {canAct ? <Td>{i.kind === "manual" ? <CertItemForm item={i.id.replace("cert.", "")} done={i.ok} /> : null}</Td> : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </>
      )}
      <h2 className="mt-6 text-lg font-semibold">Network issues (IGM)</h2>
      {overview ? <p className="text-sm">{overview.issues.open} open, {overview.issues.overdue} past their resolution time, {overview.issues.needsManual} need manual handling.</p> : null}
      {issues === null ? <Alert tone="warning">Unavailable.</Alert> : issues.length === 0 ? <EmptyState title="No network issues" /> : (
        <Table>
          <thead><tr><Th>Issue</Th><Th>Category</Th><Th>Status</Th><Th>Dispute</Th><Th>Due</Th><Th>Note</Th>{canAct ? <Th /> : null}</tr></thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <Td><Mono>{i.issueId.slice(0, 8)}</Mono> <span className="text-xs">{i.bapId}</span></Td><Td>{i.category}{i.subCategory ? `/${i.subCategory}` : ""}</Td>
                <Td>{i.status}{i.overdue ? " (overdue)" : ""}</Td><Td>{i.disputeId ? <Link className="text-brand-700 hover:underline" href={`/disputes/${i.disputeId}`}>Open</Link> : i.needsManual ? "None: manual" : "—"}</Td>
                <Td className="whitespace-nowrap">{fmtDate(i.expectedResolutionAt)}</Td><Td>{i.description}</Td>
                {canAct ? <Td>{i.needsManual && (i.status === "open" || i.status === "processing") ? <ResolveIssueForm id={i.id} /> : null}</Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <h2 className="mt-6 text-lg font-semibold">Evaluation (last 90 days)</h2>
      {evaluation === null ? <Alert tone="warning">Unavailable.</Alert> : (
        <Table>
          <tbody>
            <tr><Th>Incremental GMV</Th><Td>Rs {(evaluation.incrementalGmvPaise / 100).toLocaleString("en-IN")} across {evaluation.orders.total - evaluation.orders.cancelled} orders ({evaluation.orders.cancelled} cancelled)</Td></tr>
            <tr><Th>Dispute load</Th><Td>{evaluation.issues.total} issues, {evaluation.issues.withDispute} disputes: {evaluation.issuesPer100Orders} issues / {evaluation.disputesPer100Orders} disputes per 100 orders</Td></tr>
            <tr><Th>Resolved within TTL</Th><Td>{evaluation.resolvedWithinTtl === null ? "n/a" : `${Math.round(evaluation.resolvedWithinTtl * 100)}%`} (median {evaluation.medianResolutionHours ?? "n/a"} h)</Td></tr>
          </tbody>
        </Table>
      )}
      <h2 className="mt-6 text-lg font-semibold">Failed callbacks</h2>
      {failed === null ? <Alert tone="warning">Unavailable.</Alert> : failed.length === 0 ? <EmptyState title="Nothing failed" description="Every callback was delivered." /> : (
        <Table>
          <thead><tr><Th>Callback</Th><Th>Buyer app</Th><Th>Error</Th><Th>Attempts</Th><Th>When</Th>{canAct ? <Th /> : null}</tr></thead>
          <tbody>
            {failed.map((m) => (
              <tr key={m.id}>
                <Td><Mono>{m.action}</Mono></Td><Td>{m.counterpartyId ?? "—"}</Td><Td>{m.error ?? "—"}{m.httpStatus ? ` (${m.httpStatus})` : ""}</Td><Td>{m.attempts}</Td><Td className="whitespace-nowrap">{fmtDate(m.createdAt)}</Td>
                {canAct ? <Td><ReplayButton id={m.id} /></Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <h2 className="mt-6 text-lg font-semibold">Message log</h2>
      <LinkTabs label="Filter by direction" items={[{ href: "/ondc", label: "All", active: !direction }, { href: "/ondc?direction=inbound", label: "Inbound", active: direction === "inbound" }, { href: "/ondc?direction=outbound", label: "Outbound", active: direction === "outbound" }]} />
      {log === null ? <Alert tone="warning">Unavailable.</Alert> : log.length === 0 ? <EmptyState title="No messages yet" /> : (
        <Table>
          <thead><tr><Th>Dir</Th><Th>Action</Th><Th>Counterparty</Th><Th>Status</Th><Th>Transaction</Th><Th>When</Th><Th>Body (redacted)</Th></tr></thead>
          <tbody>
            {log.map((m) => (
              <tr key={m.id}>
                <Td>{m.direction}</Td><Td><Mono>{m.action}</Mono></Td><Td>{m.counterpartyId ?? "—"}</Td><Td>{m.status}{m.error ? `: ${m.error}` : ""}</Td>
                <Td><Mono>{m.transactionId.slice(0, 8)}</Mono></Td><Td className="whitespace-nowrap">{fmtDate(m.createdAt)}</Td>
                <Td><details><summary className="cursor-pointer text-brand-700">View</summary><pre className="mt-1 max-w-xl overflow-x-auto text-xs">{json(m.body)}</pre></details></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
