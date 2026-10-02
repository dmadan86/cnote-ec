import { adminGetNegotiation, isA2aEnabled } from "@cnote/a2a";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate } from "@/lib/util";
import { SuspendForm } from "../../forms";

export const metadata = { title: "Negotiation" };
const rupees = (paise: number) => `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default async function NegotiationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { staff } = await requireStaff(`/agents/negotiations/${id}`, "agents.read");
  const canSuspend = hasPrivilege(staff, "agents.suspend");
  const n = await adminGetNegotiation(id);
  if (!n) notFound();
  return (
    <>
      <PageHeader title={`Negotiation ${id.slice(0, 8)}`} description="Structured transcript of typed protocol messages. Private limits of either party are never included." />
      <p className="text-sm"><Link className="font-medium text-brand-700 hover:underline" href="/agents">Back to agents</Link></p>
      {!isA2aEnabled() ? <Alert tone="warning">A2A_ENABLED is off: agents do not run. This record is read-only.</Alert> : null}
      {n.flagged ? <Alert tone="warning">This negotiation was flagged for unusual agent behaviour.</Alert> : null}
      {n.realiseError ? <Alert tone="danger">Could not create the quote/order: {n.realiseError}</Alert> : null}
      <Table>
        <tbody>
          <tr><Th>Status</Th><Td><Badge tone={n.status === "accepted" ? "success" : "neutral"}>{n.status}</Badge></Td></tr>
          <tr><Th>Buyer</Th><Td>{n.buyer.name} <Mono>{n.buyer.businessId}</Mono> ({n.buyerConfirmed ? "confirmed" : "not confirmed"})</Td></tr>
          <tr><Th>Seller</Th><Td>{n.seller.name} <Mono>{n.seller.businessId}</Mono> ({n.sellerConfirmed ? "confirmed" : "not confirmed"})</Td></tr>
          <tr><Th>Round</Th><Td>{n.round} of {n.maxRounds}{n.turn ? `, ${n.turn}'s turn` : ""}</Td></tr>
          <tr><Th>Agreed terms</Th><Td>{n.agreed ? `${rupees(n.agreed.pricePaise)} per ${n.agreed.unit}, qty ${n.agreed.quantity}, lead time ${n.agreed.leadTimeDays}d` : "None"}</Td></tr>
          <tr><Th>External agent</Th><Td>{n.external ? "Yes" : "No"}</Td></tr>
          <tr><Th>Quote / order</Th><Td>{n.quoteId ? <Mono>{n.quoteId}</Mono> : "—"} / {n.orderId ? <Mono>{n.orderId}</Mono> : "—"}</Td></tr>
          <tr><Th>Enquiry / match</Th><Td><Mono>{n.enquiryId}</Mono> / <Mono>{n.matchId}</Mono></Td></tr>
          <tr><Th>Created / expires / closed</Th><Td>{fmtDate(n.createdAt)} / {fmtDate(n.expiresAt)} / {n.closedAt ? fmtDate(n.closedAt) : "—"}</Td></tr>
        </tbody>
      </Table>
      <h2 className="mt-6 text-lg font-semibold">Transcript</h2>
      <Table>
        <thead><tr><Th>#</Th><Th>When</Th><Th>Side</Th><Th>Actor</Th><Th>Type</Th><Th>Price / unit</Th><Th>Qty</Th><Th>Lead time</Th><Th>Terms</Th></tr></thead>
        <tbody>
          {n.messages.map((m) => (
            <tr key={m.seq}>
              <Td>{m.seq}</Td><Td>{fmtDate(m.createdAt)}</Td><Td>{m.side}</Td><Td>{m.actor.replace("_", " ")}</Td><Td>{m.type}</Td>
              <Td>{m.offer ? rupees(m.offer.pricePaise) : "—"}</Td><Td>{m.offer ? `${m.offer.quantity} ${m.offer.unit}` : "—"}</Td><Td>{m.offer ? `${m.offer.leadTimeDays}d` : "—"}</Td>
              <Td>{m.offer ? [m.offer.deliveryTerms, m.offer.paymentTerms].filter(Boolean).join("; ") || "—" : "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {canSuspend ? (
        <>
          <h2 className="mt-6 text-lg font-semibold">Suspend</h2>
          <div className="space-y-3">
            {(["buyer", "seller"] as const).map((s) => (
              <div key={s}>
                <p className="mb-1 text-sm">Suspend the {s}&apos;s agents ({n[s].name})</p>
                <SuspendForm fixed={{ kind: "business", targetId: n[s].businessId }} label={`Suspend ${s} agents`} />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
