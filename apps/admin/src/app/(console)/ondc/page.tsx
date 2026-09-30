import { hasPrivilege } from "@cnote/admin";
import { adminOverview, listFailedCallbacks, listMessages } from "@/lib/ondc";
import { Alert, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, json, one, safe } from "@/lib/util";
import { ReplayButton } from "./buttons";

export const metadata = { title: "ONDC" };

export default async function OndcPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { staff } = await requireStaff("/ondc", "ondc.manage");
  const sp = await searchParams;
  const direction = one(sp.direction) === "inbound" ? "inbound" : one(sp.direction) === "outbound" ? "outbound" : undefined;
  const canAct = hasPrivilege(staff, "ondc.manage");
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
      <nav aria-label="Filter by direction" className="flex gap-3 text-sm">
        <Link href="/ondc" className={!direction ? "font-semibold text-brand-700" : "text-brand-700 hover:underline"}>All</Link>
        <Link href="/ondc?direction=inbound" className={direction === "inbound" ? "font-semibold text-brand-700" : "text-brand-700 hover:underline"}>Inbound</Link>
        <Link href="/ondc?direction=outbound" className={direction === "outbound" ? "font-semibold text-brand-700" : "text-brand-700 hover:underline"}>Outbound</Link>
      </nav>
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
