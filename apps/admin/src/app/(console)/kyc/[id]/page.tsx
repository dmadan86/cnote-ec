import { hasPrivilege } from "@cnote/admin";
import { getKycReview } from "@cnote/identity";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Mono } from "@/components/table";
import { KycDecisionForm } from "@/features/kyc/decision-form";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "KYC session" };
const tone = (v: string) => (v === "pass" ? "success" : v === "fail" ? "danger" : "warning");

export default async function KycDetailPage({ params }: PageProps<"/kyc/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/kyc/${id}`);
  if (!hasPrivilege(staff, "kyc.review")) redirect("/no-access?need=kyc.review");
  const s = await safe("identity.getKycReview", () => getKycReview(id));
  if (!s) notFound();
  const d = s.declared;
  return (
    <>
      <PageHeader title={s.businessName} description={<><Link href="/kyc" className="text-brand-700 hover:underline">Queue</Link> · session <Mono>{s.id.slice(0, 8)}</Mono> · {fmtDate(s.createdAt)}</>} />
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          {s.documents.map((doc) => (
            <Card key={doc.id}>
              <CardHeader><CardTitle>{doc.docType.replace(/_/g, " ")}</CardTitle><Badge tone={tone(doc.verdict)}>{doc.verdict}</Badge></CardHeader>
              <CardBody className="grid gap-4 md:grid-cols-2">
                {doc.hasImage ? (
                  // eslint-disable-next-line @next/next/no-img-element -- staff-gated no-store route
                  <img src={`/media/kyc/${doc.id}`} alt={`${doc.docType} uploaded by the seller`} className="max-h-96 w-full rounded-lg bg-canvas object-contain" />
                ) : <p className="text-sm text-muted">Image purged after the retention window.</p>}
                <div className="space-y-3 text-sm">
                  <table className="w-full">
                    <thead><tr className="text-left text-xs text-muted"><th className="pb-1 font-medium">Field</th><th className="pb-1 font-medium">On document</th><th className="pb-1 font-medium">Declared</th></tr></thead>
                    <tbody>
                      <Row label="Name" doc={doc.extracted.name} declared={d.legalName ?? d.name} />
                      <Row label="GSTIN" doc={doc.extracted.gstin} declared={d.gstin} mono />
                      <Row label="PAN" doc={doc.extracted.pan} declared={d.panMasked} mono />
                      {doc.extracted.address ? <Row label="Address" doc={doc.extracted.address} declared={null} /> : null}
                      {doc.extracted.udyam ? <Row label="Udyam" doc={doc.extracted.udyam} declared={null} mono /> : null}
                    </tbody>
                  </table>
                  {doc.reasons.length ? (
                    <div><p className="text-xs font-semibold uppercase tracking-wide text-muted">Signals</p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5">{doc.reasons.map((r) => <li key={r}>{r}</li>)}</ul></div>
                  ) : <p className="text-muted">No signals raised.</p>}
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Video KYC</CardTitle><Badge>{s.status}</Badge></CardHeader>
            <CardBody className="space-y-2 text-sm">
              <p>Liveness: <b>{s.livenessScore != null ? s.livenessScore.toFixed(2) : "n/a"}</b> · Face match: <b>{s.faceMatchScore != null ? s.faceMatchScore.toFixed(2) : "n/a"}</b></p>
              {s.reasons.length ? <ul className="list-disc space-y-0.5 pl-5 text-muted">{s.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
              <p className="text-xs text-muted">Only provider scores are stored; no video or face data.</p>
            </CardBody>
          </Card>
          {s.status === "review" ? (
            hasPrivilege(staff, "kyc.review") ? <Card><CardHeader><CardTitle>Decision</CardTitle></CardHeader><CardBody><KycDecisionForm id={s.id} /></CardBody></Card> : null
          ) : <Alert tone="info">Decided: {s.status}{s.reviewNote ? ` (${s.reviewNote})` : ""}.</Alert>}
        </div>
      </div>
    </>
  );
}

function Row({ label, doc, declared, mono }: { label: string; doc?: string; declared?: string | null; mono?: boolean }) {
  const cls = mono ? "font-mono text-xs" : "";
  return (
    <tr className="align-top">
      <td className="py-1 pr-2 text-muted">{label}</td>
      <td className={`py-1 pr-2 ${cls}`}>{doc ?? <span className="text-muted">not read</span>}</td>
      <td className={`py-1 ${cls}`}>{declared ?? <span className="text-muted">n/a</span>}</td>
    </tr>
  );
}
