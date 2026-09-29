import { hasPrivilege } from "@cnote/admin";
import { getBalance, getLedger } from "@cnote/billing";
import { getTrustProfiles, listVerificationRecords } from "@cnote/identity";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader, Stat, TrustBadge } from "@cnote/ui";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Business" };

export default async function BusinessDetailPage({ params }: PageProps<"/businesses/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/businesses/${id}`, "businesses.read");
  if (!z.uuid().safeParse(id).success) notFound();
  const canBilling = hasPrivilege(staff, "billing.read");
  const [profiles, records, balance, ledger] = await Promise.all([
    safe("identity.getTrustProfiles", () => getTrustProfiles([id])),
    safe("identity.listVerificationRecords", () => listVerificationRecords(id)),
    canBilling ? safe("billing.getBalance", () => getBalance(id)) : null,
    canBilling ? safe("billing.getLedger", () => getLedger(id, 50)) : null,
  ]);
  const profile = profiles?.get(id);
  if (profiles && !profile) notFound();
  return (
    <>
      <PageHeader title={profile?.name ?? "Business"} description={<Mono>{id}</Mono>} />
      {!profile ? <Alert tone="warning">Trust profile unavailable.</Alert> : (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Verification tier" value={`T${profile.verificationTier}`} hint={<TrustBadge tier={profile.verificationTier} badgeActive={profile.badgeActive} />} />
          <Stat label="Trust score" value={profile.trustScore} />
          <Stat label="Location" value={<span className="text-base">{[profile.city, profile.state, profile.pincode].filter(Boolean).join(", ") || "—"}</span>} />
          <Stat label="Languages" value={<span className="text-base">{profile.languages.join(", ") || "—"}</span>} />
        </div>
      )}
      <Card>
        <CardHeader><CardTitle>Verification records</CardTitle></CardHeader>
        <CardBody>
          {records === null ? <Alert tone="warning">Unavailable.</Alert> : records.length === 0 ? <p className="text-sm text-muted">No records.</p> : (
            <Table>
              <thead><tr><Th>When</Th><Th>Tier</Th><Th>Kind</Th><Th>Status</Th><Th>Provider</Th></tr></thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td><Td>T{r.tier}</Td><Td>{r.kind}</Td>
                    <Td><Badge tone={r.status === "passed" ? "success" : r.status === "failed" ? "danger" : "warning"}>{r.status}</Badge></Td>
                    <Td>{r.provider}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      {canBilling ? (
        <Card>
          <CardHeader><CardTitle>Lead credits</CardTitle><span className="text-sm text-muted">Balance: <strong className="text-ink">{balance ?? "—"}</strong></span></CardHeader>
          <CardBody>
            {ledger === null ? <Alert tone="warning">Ledger unavailable.</Alert> : ledger.length === 0 ? <p className="text-sm text-muted">No ledger entries.</p> : (
              <Table>
                <thead><tr><Th>When</Th><Th>Reason</Th><Th>Δ</Th><Th>Ref</Th><Th>Expires</Th></tr></thead>
                <tbody>
                  {ledger.map((e) => (
                    <tr key={e.id}>
                      <Td className="whitespace-nowrap">{fmtDate(e.createdAt)}</Td><Td>{e.reason}</Td>
                      <Td className={e.delta < 0 ? "text-danger" : "text-success"}>{e.delta > 0 ? `+${e.delta}` : e.delta}</Td>
                      <Td>{e.refType ? `${e.refType}:${e.refId?.slice(0, 8) ?? ""}` : "—"}</Td>
                      <Td className="whitespace-nowrap">{e.expiresAt ? fmtDate(e.expiresAt) : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
