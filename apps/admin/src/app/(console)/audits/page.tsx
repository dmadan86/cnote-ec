import { hasPrivilege } from "@cnote/admin";
import { getAuditSubmission, listAuditPartners, listAudits, listReauditsDue, type AuditSubmissionDetail, type AuditView } from "@cnote/identity";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Mono } from "@/components/table";
import { RecordAuditForm, RequestAuditForm, ScheduleAuditForm } from "@/features/kyc/audit-forms";
import { AssignPartnerForm, IssueLinkForm, NewPartnerForm, PartnerToggle, ReviewSubmissionForm } from "@/features/kyc/partner-forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Audits (T3)" };
const tone = (s: string) => (s === "completed" ? "success" : s === "failed" ? "danger" : s === "expired" || s === "cancelled" ? "neutral" : "warning");

function Submission({ s }: { s: AuditSubmissionDetail }) {
  return (
    <div className="space-y-3 rounded-lg border border-line bg-canvas p-3 text-sm">
      <p><span className="font-medium">{s.inspector}</span> for {s.partner} · submitted {s.submittedAt ? fmtDate(s.submittedAt) : "—"}{s.siteRadiusM !== null ? ` · photos within ${s.siteRadiusM} m` : ""}</p>
      <p className="text-muted">{s.summary}</p>
      {s.flags.length ? (
        <Alert tone="warning"><ul className="list-disc space-y-0.5 pl-5">{s.flags.map((f) => <li key={f}>{f}</li>)}</ul></Alert>
      ) : <Badge tone="success">No automatic flags</Badge>}
      <ul className="space-y-1">
        {s.checklist.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2">
            <Badge tone={c.ok === true ? "success" : c.ok === false ? "danger" : "neutral"}>{c.ok === true ? "yes" : c.ok === false ? "no" : "not answered"}</Badge>
            <span>{c.label}</span>{c.note ? <span className="text-muted">({c.note})</span> : null}
          </li>
        ))}
      </ul>
      <ul className="grid gap-3 sm:grid-cols-3">
        {s.photos.map((p) => (
          <li key={p.index} className="space-y-1">
            {/* private staff-only image route, never cached */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/media/audit/${s.auditId}/${p.index}`} alt={`Site photo ${p.index + 1}`} loading="lazy" className="aspect-video w-full rounded border border-line object-cover" />
            <p className="text-xs text-muted">{p.lat !== null && p.lng !== null ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : "no location"}{p.capturedAt ? ` · ${fmtDate(p.capturedAt)}` : ""}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function AuditsPage() {
  const { staff } = await requireStaff("/audits");
  if (!hasPrivilege(staff, "audits.manage")) redirect("/no-access?need=audits.manage");
  const [items, partners, due] = await Promise.all([
    safe("identity.listAudits", () => listAudits({ limit: 100 })),
    safe("identity.listAuditPartners", () => listAuditPartners()),
    safe("identity.listReauditsDue", () => listReauditsDue()),
  ]);
  const subs = new Map<string, AuditSubmissionDetail>();
  for (const a of items ?? []) if (a.status === "submitted") { const s = await safe("identity.getAuditSubmission", () => getAuditSubmission(a.id)); if (s) subs.set(a.id, s); }
  const activePartners = (partners ?? []).filter((p) => p.active);
  return (
    <>
      <PageHeader title="Audits (Tier 3)" description="Physical audits by partner agencies. The partner gets a single-use link, submits a checklist and geotagged photos, and you review it. A pass lifts the business to Tier 3 until its validity date; it then falls back to Tier 2. Re-audit is prompted 30 days before." />
      <Card><CardBody><RequestAuditForm /><p className="mt-2 text-xs text-muted">The business must already be KYC verified (Tier 2). Find the ID on the <Link href="/businesses" className="text-brand-700 hover:underline">Businesses</Link> page. Pick a partner from the list below and assign it on the audit, or type an agency name here to record a result you received outside the system.</p></CardBody></Card>

      <section aria-labelledby="partners" className="space-y-2">
        <h2 id="partners" className="text-lg font-bold text-ink">Audit partners</h2>
        <Card><CardBody className="space-y-3">
          <NewPartnerForm />
          <ul className="divide-y divide-line text-sm">
            {(partners ?? []).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-medium">{p.name} {p.contactEmail ? <span className="font-normal text-muted">· {p.contactEmail}</span> : null} {p.active ? null : <Badge>inactive</Badge>}</span>
                <PartnerToggle id={p.id} active={p.active} />
              </li>
            ))}
            {partners && partners.length === 0 ? <li className="py-2 text-muted">No partners yet.</li> : null}
          </ul>
        </CardBody></Card>
      </section>

      {due && due.length ? (
        <Alert tone="warning">
          <p className="font-medium">Re-audit due</p>
          <ul className="list-disc pl-5 text-sm">{due.map((a) => <li key={a.id}>{a.businessName ?? "Business"}: due since {a.reAuditDueAt ? fmtDate(a.reAuditDueAt) : "—"}, Tier 3 lapses {a.validUntil ? fmtDate(a.validUntil) : "—"}</li>)}</ul>
        </Alert>
      ) : null}

      {items === null ? <Alert tone="warning">Audits are currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="No audits yet" description="Request one above." /> : null}
      <ul className="space-y-3">
        {(items ?? []).map((a: AuditView) => (
          <li key={a.id}>
            <Card><CardBody className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="font-semibold">{a.businessName ?? "Business"} <span className="text-sm font-normal text-muted">· {a.partner}</span></p>
                  <p className="text-xs text-muted"><Mono>{a.id.slice(0, 8)}</Mono> · requested {fmtDate(a.createdAt)}{a.scheduledFor ? ` · scheduled ${fmtDate(a.scheduledFor)}` : ""}{a.validUntil ? ` · valid until ${fmtDate(a.validUntil)}` : ""}{a.reAuditDueAt ? ` · re-audit from ${fmtDate(a.reAuditDueAt)}` : ""}</p></div>
                <div className="flex gap-1.5"><Badge tone={tone(a.status)}>{a.status}</Badge>{a.result ? <Badge tone={a.result === "pass" ? "success" : a.result === "fail" ? "danger" : "warning"}>{a.result}</Badge> : null}</div>
              </div>
              {a.status === "requested" || a.status === "scheduled" ? (
                <div className="space-y-3 border-t border-line pt-3">
                  <ScheduleAuditForm id={a.id} />
                  <div className="flex flex-wrap items-start gap-4">
                    <AssignPartnerForm id={a.id} partners={activePartners} current={a.partnerId} />
                    {a.partnerId ? <IssueLinkForm id={a.id} /> : <p className="text-xs text-muted">Assign a partner to issue its upload link.</p>}
                  </div>
                  {a.reviewNote ? <p className="text-sm text-muted">Sent back: {a.reviewNote}</p> : null}
                  <details className="text-sm"><summary className="cursor-pointer text-muted">Record a result received outside the system</summary><div className="pt-2"><RecordAuditForm id={a.id} /></div></details>
                </div>
              ) : null}
              {a.status === "submitted" && subs.get(a.id) ? (
                <div className="space-y-3 border-t border-line pt-3"><Submission s={subs.get(a.id)!} /><ReviewSubmissionForm id={a.id} /></div>
              ) : null}
              {a.findings && typeof a.findings === "object" && "summary" in a.findings ? <p className="text-sm text-muted">{String((a.findings as { summary: unknown }).summary)}</p> : null}
            </CardBody></Card>
          </li>
        ))}
      </ul>
    </>
  );
}
