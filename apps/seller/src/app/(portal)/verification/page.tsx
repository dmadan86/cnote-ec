import type { Metadata } from "next";
import { CheckCircle2, Circle, Clock } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader, TrustBadge } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { identity } from "@/lib/services";
import { GstForm } from "@/features/verification/gst-form";
import { KycPanel } from "@/features/kyc/kyc-panel";
import { T3Status } from "@/features/kyc/t3-status";
import { RegistryCard } from "@/features/verification/registry-card";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("verification");
  return { title: t("meta") };
}

export default async function VerificationPage() {
  const session = await requireSeller("/verification");
  const b = session.business;
  const t = await getTranslations("verification");
  const f = await getFormatter();
  const records = await load(() => identity.listVerificationRecords(b.id));
  const kyc = await load(async () => (b.verificationTier === 1 ? identity.getKycSession({ personId: session.personId, businessId: b.id }) : null));
  const registry = await load(() => identity.getRegistryStatus(b.id));
  const company = await load(() => identity.getCompanyProfile(b.id));
  const audits = await load(() => identity.listAudits({ businessId: b.id, limit: 1 }));
  const audit = audits.ok ? audits.data[0] ?? null : null;
  // computed on the server per request (render-time clocks are impure in components)
  const reAuditDue = !!audit?.reAuditDueAt && new Date(audit.reAuditDueAt).getTime() <= new Date().getTime();

  const tiers = [
    { tier: 0, name: t("tiers.t0.name"), body: t("tiers.t0.body"), done: session.phoneVerified, soon: false },
    { tier: 1, name: t("tiers.t1.name"), body: t("tiers.t1.body"), done: b.verificationTier >= 1, soon: false },
    { tier: 2, name: t("tiers.t2.name"), body: t("tiers.t2.body"), done: b.verificationTier >= 2, soon: false },
    { tier: 3, name: t("tiers.t3.name"), body: t("tiers.t3.body"), done: b.verificationTier >= 3, soon: false },
  ];

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="flex items-center gap-2 text-sm text-ink">
        {t("currentBadge")} <TrustBadge tier={b.verificationTier} badgeActive={b.badgeActive} />
      </div>
      {!b.badgeActive && b.verificationTier >= 1 ? <Alert tone="warning">{t("paused")}</Alert> : null}

      <ol className="space-y-3" aria-label={t("tiersLabel")}>
        {tiers.map((tr) => (
          <li key={tr.tier}>
            <Card>
              <CardBody className="flex gap-3">
                {tr.done ? <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" aria-hidden /> : tr.soon ? <Clock className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />}
                <div>
                  <h2 className="font-semibold text-ink">
                    {tr.name} {tr.done ? <Badge tone="success" className="ml-1">{t("done")}</Badge> : tr.soon ? <Badge className="ml-1">{t("comingSoon")}</Badge> : <Badge tone="warning" className="ml-1">{t("toDo")}</Badge>}
                  </h2>
                  <p className="mt-1 text-sm text-muted">{tr.body}</p>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ol>

      {b.verificationTier < 1 ? (
        <Card>
          <CardHeader><CardTitle>{t("gstCard")}</CardTitle></CardHeader>
          <CardBody><GstForm mode="portal" /></CardBody>
        </Card>
      ) : null}

      {b.verificationTier === 1 ? (
        <Card>
          <CardHeader><CardTitle>{t("kycCard")}</CardTitle></CardHeader>
          <CardBody>{kyc.ok ? <KycPanel initial={kyc.data} /> : <Alert tone="danger">{kyc.error}</Alert>}</CardBody>
        </Card>
      ) : null}

      {b.verificationTier >= 1 && registry.ok && registry.data ? (
        <Card>
          <CardHeader><CardTitle>{t("registry.title")}</CardTitle></CardHeader>
          <CardBody>
            <RegistryCard
              udyam={registry.data.udyam} udyamVerifiedAt={registry.data.udyamVerifiedAt} cin={registry.data.cin} mcaVerifiedAt={registry.data.mcaVerifiedAt} mcaStatus={registry.data.mcaStatus}
              showCin={company.ok && !!company.data && ["private_limited", "public_limited", "llp"].includes(company.data.companyType ?? "")}
            />
          </CardBody>
        </Card>
      ) : null}

      {b.verificationTier >= 2 || audit ? (
        <Card>
          <CardHeader><CardTitle>{t("auditCard")}</CardTitle></CardHeader>
          <CardBody><T3Status audit={audit} tier={b.verificationTier} reAuditDue={reAuditDue} /></CardBody>
        </Card>
      ) : null}

      <section aria-labelledby="records" className="space-y-2">
        <h2 id="records" className="text-lg font-bold text-ink">{t("history")}</h2>
        {!records.ok ? <Alert tone="danger">{records.error}</Alert> : records.data.length === 0 ? <p className="text-sm text-muted">{t("noChecks")}</p> : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {records.data.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <span className="text-ink">T{r.tier} · {r.kind}</span>
                <span className="flex items-center gap-2 text-muted">
                  <Badge tone={r.status === "passed" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{t.has(`status.${r.status}`) ? t(`status.${r.status}`) : r.status}</Badge>
                  {f.dateTime(new Date(r.createdAt), { dateStyle: "medium" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
