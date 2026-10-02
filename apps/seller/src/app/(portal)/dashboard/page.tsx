import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, CardHeader, CardTitle, PageHeader, Stat, TrustBadge, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { alerts, billing, catalogue, enquiry } from "@/lib/services";
import { getOnboardingState } from "@/features/onboarding/state";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("dashboard");
  return { title: t("meta") };
}

const IMPROVES = ["i1", "i2", "i3", "i4"] as const;

export default async function DashboardPage() {
  const session = await requireSeller("/dashboard");
  const b = session.business;
  const t = await getTranslations("dashboard");
  const [balance, leads, listings, followers, onboarding] = await Promise.all([
    load(() => billing.getBalance(b.id)),
    load(() => enquiry.listSellerLeads(b.id)),
    load(() => catalogue.listSellerListings(b.id)),
    // aggregate only: how many buyers follow this business, never who (docs/design/buyer-retention.md)
    load(() => alerts.countFollowers(b.id)),
    getOnboardingState(session).catch(() => null),
  ]);

  const open = leads.ok ? leads.data.filter((l) => l.status === "offered").length : null;
  // Answered = accepted/declined/refunded; expired = the 2h window passed with no answer.
  let sla: string | null = null;
  if (leads.ok) {
    const answered = leads.data.filter((l) => ["accepted", "declined", "refunded"].includes(l.status)).length;
    const expired = leads.data.filter((l) => l.status === "expired").length;
    sla = answered + expired === 0 ? t("stats.noData") : `${Math.round((answered / (answered + expired)) * 100)}%`;
  }
  const published = listings.ok ? listings.data.filter((l) => l.status === "published").length : null;
  const incomplete = onboarding !== null && onboarding.step !== "done";

  const ladder = [
    { label: t("verification.t0"), done: session.phoneVerified },
    { label: t("verification.t1"), done: b.verificationTier >= 1, href: "/verification" },
    { label: t("verification.t2"), done: b.verificationTier >= 2 },
    { label: t("verification.t3"), done: b.verificationTier >= 3 },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("welcome", { name: b.name })} description={t("description")} />

      {incomplete ? (
        <Alert tone="info">
          {t.rich("setupIncomplete", { link: (c) => <Link href="/onboarding" className="font-semibold underline">{c}</Link> })}
        </Alert>
      ) : null}
      {published === 0 ? (
        <Alert tone="warning">
          {t.rich("noListing", { link: (c) => <Link href="/listings/new" className="font-semibold underline">{c}</Link> })}
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label={t("stats.credits")} value={balance.ok ? balance.data : "-"} hint={<Link href="/billing" className="underline">{t("stats.billing")}</Link>} />
        <Stat label={t("stats.openLeads")} value={open ?? "-"} hint={<Link href="/leads" className="underline">{t("stats.answerNow")}</Link>} />
        <Stat label={t("stats.response")} value={sla ?? "-"} hint={t("stats.responseHint")} />
        <Stat label={t("stats.followers")} value={followers.ok ? followers.data : "-"} hint={t("stats.followersHint")} />
        <Stat label={t("stats.trust")} value={b.trustScore} hint={<TrustBadge tier={b.verificationTier} badgeActive={b.badgeActive} />} />
      </div>
      {!leads.ok || !balance.ok ? <Alert tone="danger">{t("stats.loadFail")}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("verification.title")}</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <ul className="space-y-2">
              {ladder.map((rung) => (
                <li key={rung.label} className="flex items-center gap-2 text-sm text-ink">
                  {rung.done ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <Circle className="size-4 text-muted" aria-hidden />}
                  <span className={rung.done ? "" : "text-muted"}>{rung.label}</span>
                  <span className="sr-only">{rung.done ? t("verification.done") : t("verification.notDone")}</span>
                </li>
              ))}
            </ul>
            {b.verificationTier < 1 ? <Link href="/verification" className={buttonClasses("primary", "md", "min-h-11")}>{t("verification.verifyGst")}</Link> : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>{t("improves.title")}</CardTitle></CardHeader>
          <CardBody>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink">{IMPROVES.map((i) => <li key={i}>{t(`improves.${i}`)}</li>)}</ul>
            <p className="mt-3 text-xs text-muted">{t("improves.note")}</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
