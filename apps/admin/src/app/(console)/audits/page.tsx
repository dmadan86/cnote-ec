import { hasPrivilege } from "@cnote/admin";
import { listAudits, type AuditView } from "@cnote/identity";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Mono } from "@/components/table";
import { RecordAuditForm, RequestAuditForm, ScheduleAuditForm } from "@/features/kyc/audit-forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "Audits (T3)" };
const tone = (s: string) => (s === "completed" ? "success" : s === "failed" ? "danger" : s === "expired" || s === "cancelled" ? "neutral" : "warning");

export default async function AuditsPage() {
  const { staff } = await requireStaff("/audits");
  if (!hasPrivilege(staff, "audits.manage")) redirect("/no-access?need=audits.manage");
  const items = await safe("identity.listAudits", () => listAudits({ limit: 100 }));
  return (
    <>
      <PageHeader title="Audits (Tier 3)" description="Physical or partner audits for categories that need them. A passing result lifts the business to Tier 3 until its validity date; it then falls back to Tier 2." />
      <Card><CardBody><RequestAuditForm /><p className="mt-2 text-xs text-muted">The business must already be KYC verified (Tier 2). Find the ID on the <Link href="/businesses" className="text-brand-700 hover:underline">Businesses</Link> page.</p></CardBody></Card>
      {items === null ? <Alert tone="warning">Audits are currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="No audits yet" description="Request one above." /> : null}
      <ul className="space-y-3">
        {(items ?? []).map((a: AuditView) => (
          <li key={a.id}>
            <Card><CardBody className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><p className="font-semibold">{a.businessName ?? "Business"} <span className="text-sm font-normal text-muted">· {a.partner}</span></p>
                  <p className="text-xs text-muted"><Mono>{a.id.slice(0, 8)}</Mono> · requested {fmtDate(a.createdAt)}{a.scheduledFor ? ` · scheduled ${fmtDate(a.scheduledFor)}` : ""}{a.validUntil ? ` · valid until ${fmtDate(a.validUntil)}` : ""}</p></div>
                <div className="flex gap-1.5"><Badge tone={tone(a.status)}>{a.status}</Badge>{a.result ? <Badge tone={a.result === "pass" ? "success" : a.result === "fail" ? "danger" : "warning"}>{a.result}</Badge> : null}</div>
              </div>
              {a.status === "requested" || a.status === "scheduled" ? (
                <div className="space-y-3 border-t border-line pt-3"><ScheduleAuditForm id={a.id} /><RecordAuditForm id={a.id} /></div>
              ) : null}
              {a.findings && typeof a.findings === "object" && "summary" in a.findings ? <p className="text-sm text-muted">{String((a.findings as { summary: unknown }).summary)}</p> : null}
            </CardBody></Card>
          </li>
        ))}
      </ul>
    </>
  );
}
