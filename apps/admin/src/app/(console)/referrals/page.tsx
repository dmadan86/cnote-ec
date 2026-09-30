import { listReferralsForReview } from "@cnote/promotions";
import { Alert, Badge, EmptyState, PageHeader } from "@cnote/ui";
import { Mono, Table, Td, Th } from "@/components/table";
import { ReferralActions } from "@/features/promotions/review-forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe, shortId } from "@/lib/util";

export const metadata = { title: "Referrals" };
const FLAG: Record<string, string> = { shared_phone: "Same phone number", shared_gstin: "Same GSTIN", referral_ring: "Referral ring (they referred each other)", shared_ip: "Same network", shared_device: "Same device" };

export default async function ReferralsPage() {
  await requireStaff("/referrals", "referrals.review");
  const rows = await safe("referrals.review", () => listReferralsForReview());
  return (
    <>
      <PageHeader title="Referral review" description="Referrals with a fraud signal. Clean referrals are paid automatically after the 7-day hold; these wait for you. Rewards are lead credits, never cash. A rejection reason is shown to the referrer." />
      {rows === null ? <Alert tone="warning">Referrals are currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="Nothing flagged" description="No referral currently needs review." /> : (
        <Table>
          <thead><tr><Th>Referrer</Th><Th>Referee</Th><Th>Status</Th><Th>Signals</Th><Th>Qualified</Th><Th>Decision</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <Td><Mono>{shortId(r.referrerBusinessId)}</Mono></Td>
              <Td><p>{r.refereeName ?? "Business"}</p><Mono>{shortId(r.refereeBusinessId)}</Mono></Td>
              <Td><Badge tone={r.status === "qualified" ? "warning" : "neutral"}>{r.status}</Badge></Td>
              <Td><ul className="space-y-1">{r.riskFlags.map((f) => <li key={f}><Badge tone="danger">{FLAG[f] ?? f}</Badge></li>)}</ul></Td>
              <Td className="whitespace-nowrap text-xs">{r.qualifiedAt ? <>{fmtDate(r.qualifiedAt)}<br />{r.qualifyingAction?.replace(/_/g, " ")}</> : "Not yet"}</Td>
              <Td className="min-w-72">{r.status === "qualified" ? <ReferralActions id={r.id} /> : <p className="text-xs text-muted">Waiting for the referee to qualify.</p>}</Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
    </>
  );
}
