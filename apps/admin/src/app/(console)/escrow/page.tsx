import { listEscrows } from "@cnote/escrow";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader, type BadgeTone } from "@cnote/ui";
import Link from "next/link";
import { inr } from "@/features/payments/format";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Escrow" };
export const dynamic = "force-dynamic";

const STATUSES = ["awaiting_funding", "funded", "accepted", "released", "refunded", "cancelled"] as const;
const TONE: Record<string, BadgeTone> = { funded: "brand", accepted: "success", released: "success", refunded: "neutral", cancelled: "neutral", awaiting_funding: "warning", created: "neutral" };

export default async function EscrowPage({ searchParams }: PageProps<"/escrow">) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === one(sp.status));
  const frozen = one(sp.frozen) === "1";
  await requireStaff("/escrow", "escrow.read");
  const rows = await safe("escrow.list", () => listEscrows({ status, frozen: frozen ? true : undefined, limit: 100 }));
  const q = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams(Object.entries({ status, frozen: frozen ? "1" : undefined, ...o }).filter(([, v]) => v) as [string, string][]);
    return `/escrow${p.size ? `?${p}` : ""}`;
  };
  return (
    <>
      <PageHeader title="Escrow" description="Order payments held by the payment-aggregator partner. Release follows delivery milestones; a dispute freezes the money." />
      <LinkTabs label="Status" items={[{ href: q({ status: undefined }), label: "All", active: !status }, ...STATUSES.map((s) => ({ href: q({ status: s }), label: s.replace("_", " "), active: s === status }))]} />
      <LinkTabs label="Dispute overlay" items={[{ href: q({ frozen: undefined }), label: "Any", active: !frozen }, { href: q({ frozen: "1" }), label: "Frozen only", active: frozen }]} />
      <p className="text-sm"><Link href="/escrow/reconciliation" className="font-medium text-brand-700 hover:underline">Reconciliation issues</Link></p>
      {rows === null ? <Alert tone="warning">Escrow data is currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No escrows" description="Nothing matches this filter." /> : (
        <Table>
          <thead><tr><Th>Escrow</Th><Th>Created</Th><Th>Order</Th><Th>Buyer</Th><Th>Seller</Th><Th>Amount</Th><Th>Held</Th><Th>Partner</Th><Th>Status</Th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <Td><Link href={`/escrow/${e.id}`} className="font-medium text-brand-700 hover:underline"><Mono>{shortId(e.id)}</Mono></Link></Td>
                <Td className="whitespace-nowrap">{fmtDate(e.createdAt)}</Td>
                <Td><Mono>{shortId(e.orderId)}</Mono></Td>
                <Td><Link href={`/businesses/${e.buyerBusinessId}`}><Mono>{shortId(e.buyerBusinessId)}</Mono></Link></Td>
                <Td><Link href={`/businesses/${e.sellerBusinessId}`}><Mono>{shortId(e.sellerBusinessId)}</Mono></Link></Td>
                <Td className="tabular-nums">{inr(e.amountPaise)}</Td>
                <Td className="tabular-nums">{e.heldPaise ? inr(e.heldPaise) : "-"}</Td>
                <Td>{e.partner}</Td>
                <Td><Badge tone={TONE[e.status] ?? "neutral"}>{e.status.replace("_", " ")}</Badge>{e.frozen ? <> <Badge tone="danger">frozen</Badge></> : null}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
