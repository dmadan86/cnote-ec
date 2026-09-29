import { hasPrivilege } from "@cnote/admin";
import { getBalance, getLedger } from "@cnote/billing";
import { getCompanyProfile, getGstEvidence, getTrustProfiles, listVerificationRecords } from "@cnote/identity";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Field, PageHeader, Stat, Textarea, TrustBadge } from "@cnote/ui";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";
import { resolveGstReviewAction } from "../actions";

export const metadata = { title: "Business" };

export default async function BusinessDetailPage({ params }: PageProps<"/businesses/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/businesses/${id}`, "businesses.read");
  if (!z.uuid().safeParse(id).success) notFound();
  const canBilling = hasPrivilege(staff, "billing.read");
  const canVerify = hasPrivilege(staff, "businesses.verify");
  const [company, evidence, profiles, records, balance, ledger] = await Promise.all([
    safe("identity.getCompanyProfile", () => getCompanyProfile(id)),
    safe("identity.getGstEvidence", () => getGstEvidence(id, 5)),
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
        <CardHeader><CardTitle>Company profile</CardTitle>{company?.gstStatus ? <Badge tone={company.gstStatus === "Active" ? "success" : "danger"}>GST {company.gstStatus}</Badge> : null}</CardHeader>
        <CardBody>
          {company === null ? <Alert tone="warning">Unavailable.</Alert> : (
            <dl className="grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-muted">Legal name</dt><dd>{company.legalName ?? "—"}</dd>
              <dt className="text-muted">Trade name</dt><dd>{company.tradeName ?? "—"}</dd>
              <dt className="text-muted">Company type</dt><dd>{company.companyType ?? "—"}</dd>
              <dt className="text-muted">GSTIN</dt><dd>{company.gstin ? <Mono>{company.gstin}</Mono> : "—"}</dd>
              <dt className="text-muted">PAN</dt><dd><Mono>{company.panMasked ?? "—"}</Mono></dd>
              <dt className="text-muted">CIN</dt><dd>{company.cin ? <Mono>{company.cin}</Mono> : "—"}</dd>
              <dt className="text-muted">Registered address</dt><dd>{company.registeredAddress ? [company.registeredAddress.line1, company.registeredAddress.line2, company.registeredAddress.city, company.registeredAddress.state, company.registeredAddress.pincode].filter(Boolean).join(", ") : "—"}</dd>
              <dt className="text-muted">Website</dt><dd>{company.website ?? "—"}</dd>
              <dt className="text-muted">GST verified</dt><dd>{company.gstVerifiedAt ? fmtDate(company.gstVerifiedAt) : "—"}</dd>
              <dt className="text-muted">Last GST check</dt><dd>{company.gstLastCheckedAt ? fmtDate(company.gstLastCheckedAt) : "—"}</dd>
            </dl>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>GST verification evidence</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          {evidence === null ? <Alert tone="warning">Unavailable.</Alert> : evidence.length === 0 ? <p className="text-sm text-muted">No GST checks yet.</p> : evidence.map((e) => (
            <div key={e.id} className="space-y-2 rounded-lg border border-line p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={e.status === "passed" ? "success" : e.status === "failed" ? "danger" : "warning"}>{e.status}</Badge>
                <span className="text-muted">{fmtDate(e.createdAt)} · {e.provider}{e.recheck ? " · monthly re-check" : ""}{e.score != null ? ` · score ${e.score}` : ""}</span>
                {e.gstin ? <Mono>{e.gstin}</Mono> : null}
              </div>
              {e.snapshot ? <p className="text-muted">Provider: {e.snapshot.legalName || "—"}{e.snapshot.tradeName ? ` / ${e.snapshot.tradeName}` : ""} · {e.snapshot.status}{e.snapshot.registrationDate ? ` · registered ${e.snapshot.registrationDate}` : ""}{e.snapshot.taxpayerType ? ` · ${e.snapshot.taxpayerType}` : ""}</p> : null}
              {e.checks.length > 0 ? (
                <ul className="space-y-0.5">
                  {e.checks.map((c) => <li key={c.id}><Badge tone={c.result === "pass" ? "success" : c.result === "fail" ? "danger" : c.result === "warn" ? "warning" : "neutral"} className="mr-2">{c.id}</Badge>{c.detail}</li>)}
                </ul>
              ) : null}
              {e.manualReview ? <p className="text-muted">Manual review: {e.manualReview.decision}{e.manualReview.note ? ` (${e.manualReview.note})` : ""} · {fmtDate(e.manualReview.at)}</p> : null}
              {e.status === "pending" && canVerify ? (
                <ActionForm action={resolveGstReviewAction} confirm="Record this decision? It is written to the audit log." successMessage="Decision recorded.">
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="businessId" value={id} />
                  <Field label="Note (optional)" htmlFor={`note-${e.id}`} className="mb-2 max-w-xl"><Textarea id={`note-${e.id}`} name="note" maxLength={500} /></Field>
                  <div className="flex gap-2">
                    <SubmitButton name="decision" value="approved">Approve GST</SubmitButton>
                    <SubmitButton name="decision" value="rejected" variant="danger">Reject</SubmitButton>
                  </div>
                </ActionForm>
              ) : null}
            </div>
          ))}
        </CardBody>
      </Card>
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
