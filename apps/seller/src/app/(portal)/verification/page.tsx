import type { Metadata } from "next";
import { CheckCircle2, Circle, Clock } from "lucide-react";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader, TrustBadge } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { identity } from "@/lib/services";
import { GstForm } from "@/features/verification/gst-form";

export const metadata: Metadata = { title: "Verification" };

export default async function VerificationPage() {
  const session = await requireSeller("/verification");
  const b = session.business;
  const records = await load(() => identity.listVerificationRecords(b.id));

  const tiers = [
    { tier: 0, name: "T0 Phone verified", body: "Your mobile number is confirmed by OTP.", done: session.phoneVerified, soon: false },
    { tier: 1, name: "T1 GST verified", body: "Your GSTIN is checked with the GST network. Shows the GST verified badge and improves your ranking.", done: b.verificationTier >= 1, soon: false },
    { tier: 2, name: "T2 KYC verified", body: "Document and video KYC. Coming soon.", done: b.verificationTier >= 2, soon: true },
    { tier: 3, name: "T3 Audited", body: "Physical or partner audit, for categories that need it. Coming soon.", done: b.verificationTier >= 3, soon: true },
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
