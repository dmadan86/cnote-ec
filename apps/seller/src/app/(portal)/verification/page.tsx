import type { Metadata } from "next";
import { CheckCircle2, Circle, Clock } from "lucide-react";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader, TrustBadge } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { identity } from "@/lib/services";
import { GstForm } from "@/features/verification/gst-form";
import { KycPanel } from "@/features/kyc/kyc-panel";
import { T3Status } from "@/features/kyc/t3-status";

export const metadata: Metadata = { title: "Verification" };

export default async function VerificationPage() {
  const session = await requireSeller("/verification");
  const b = session.business;
  const records = await load(() => identity.listVerificationRecords(b.id));
  const kyc = await load(async () => (b.verificationTier === 1 ? identity.getKycSession({ personId: session.personId, businessId: b.id }) : null));
  const audits = await load(() => identity.listAudits({ businessId: b.id, limit: 1 }));
  const audit = audits.ok ? audits.data[0] ?? null : null;

  const tiers = [
    { tier: 0, name: "T0 Phone verified", body: "Your mobile number is confirmed by OTP.", done: session.phoneVerified, soon: false },
    { tier: 1, name: "T1 GST verified", body: "Your GSTIN is checked with the GST network. Shows the GST verified badge and improves your ranking.", done: b.verificationTier >= 1, soon: false },
    { tier: 2, name: "T2 KYC verified", body: "Document checks and a short video KYC of the owner. Shows the KYC verified badge.", done: b.verificationTier >= 2, soon: false },
    { tier: 3, name: "T3 Audited", body: "Physical or partner audit, for categories that need it. Arranged by our team.", done: b.verificationTier >= 3, soon: false },
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title="Verification" description="Your badge reflects what we have verified and how you behave. It cannot be bought." />
      <div className="flex items-center gap-2 text-sm text-ink">
        Current badge: <TrustBadge tier={b.verificationTier} badgeActive={b.badgeActive} />
      </div>
      {!b.badgeActive && b.verificationTier >= 1 ? <Alert tone="warning">Your badge is paused because your trust score is below the threshold. Responding quickly to leads and closing the loop on deals raises it.</Alert> : null}

      <ol className="space-y-3" aria-label="Verification tiers">
        {tiers.map((t) => (
          <li key={t.tier}>
            <Card>
              <CardBody className="flex gap-3">
                {t.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden /> : t.soon ? <Clock className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />}
                <div>
                  <h2 className="font-semibold text-ink">
                    {t.name} {t.done ? <Badge tone="success" className="ml-1">Done</Badge> : t.soon ? <Badge className="ml-1">Coming soon</Badge> : <Badge tone="warning" className="ml-1">To do</Badge>}
                  </h2>
                  <p className="mt-1 text-sm text-muted">{t.body}</p>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ol>

      {b.verificationTier < 1 ? (
        <Card>
          <CardHeader><CardTitle>Verify your GST</CardTitle></CardHeader>
          <CardBody><GstForm mode="portal" /></CardBody>
        </Card>
      ) : null}

      {b.verificationTier === 1 ? (
        <Card>
          <CardHeader><CardTitle>Complete KYC (Tier 2)</CardTitle></CardHeader>
          <CardBody>{kyc.ok ? <KycPanel initial={kyc.data} /> : <Alert tone="danger">{kyc.error}</Alert>}</CardBody>
        </Card>
      ) : null}

      {b.verificationTier >= 2 || audit ? (
        <Card>
          <CardHeader><CardTitle>Audit (Tier 3)</CardTitle></CardHeader>
          <CardBody><T3Status audit={audit} tier={b.verificationTier} /></CardBody>
        </Card>
      ) : null}

      <section aria-labelledby="records" className="space-y-2">
        <h2 id="records" className="text-lg font-bold text-ink">History</h2>
        {!records.ok ? <Alert tone="danger">{records.error}</Alert> : records.data.length === 0 ? <p className="text-sm text-muted">No verification checks yet.</p> : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {records.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="text-ink">T{r.tier} · {r.kind}</span>
                <span className="flex items-center gap-2 text-muted">
                  <Badge tone={r.status === "passed" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{r.status}</Badge>
                  {formatDate(r.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
