import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { Alert, Card, CardBody, CardHeader, CardTitle, PageHeader, Stat, TrustBadge, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { billing, catalogue, enquiry } from "@/lib/services";
import { getOnboardingState } from "@/features/onboarding/state";

export const metadata: Metadata = { title: "Dashboard" };

const IMPROVES = [
  "Verify your GST (moves you up a verification tier)",
  "Answer or decline every lead inside the 2-hour window",
  "Report whether deals closed, so your record stays accurate",
  "Keep listings accurate and inside the marketplace policy",
];

export default async function DashboardPage() {
  const session = await requireSeller("/dashboard");
  const b = session.business;
  const [balance, leads, listings, onboarding] = await Promise.all([
    load(() => billing.getBalance(b.id)),
    load(() => enquiry.listSellerLeads(b.id)),
    load(() => catalogue.listSellerListings(b.id)),
    getOnboardingState(session).catch(() => null),
  ]);

  const open = leads.ok ? leads.data.filter((l) => l.status === "offered").length : null;
  // Answered = accepted/declined/refunded; expired = the 2h window passed with no answer.
  let sla: string | null = null;
  if (leads.ok) {
    const answered = leads.data.filter((l) => ["accepted", "declined", "refunded"].includes(l.status)).length;
    const expired = leads.data.filter((l) => l.status === "expired").length;
    sla = answered + expired === 0 ? "No data yet" : `${Math.round((answered / (answered + expired)) * 100)}%`;
  }
  const published = listings.ok ? listings.data.filter((l) => l.status === "published").length : null;
  const incomplete = onboarding !== null && onboarding.step !== "done";

  const ladder = [
    { label: "T0 Phone verified", done: session.phoneVerified },
    { label: "T1 GST verified", done: b.verificationTier >= 1, href: "/verification" },
    { label: "T2 KYC verified (coming soon)", done: b.verificationTier >= 2 },
    { label: "T3 Audited (coming soon)", done: b.verificationTier >= 3 },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={`Welcome, ${b.name}`} description="Your leads, credits and trust at a glance." />

      {incomplete ? (
        <Alert tone="info">
          Your setup is not finished. <Link href="/onboarding" className="font-semibold underline">Continue setup</Link>
        </Alert>
      ) : null}
      {published === 0 ? (
        <Alert tone="warning">
          You have no published listing, so you cannot be matched to buyers. <Link href="/listings/new" className="font-semibold underline">Add one in a few minutes</Link>
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Lead credits" value={balance.ok ? balance.data : "-"} hint={<Link href="/billing" className="underline">Billing</Link>} />
        <Stat label="Open leads" value={open ?? "-"} hint={<Link href="/leads" className="underline">Answer now</Link>} />
        <Stat label="Response rate" value={sla ?? "-"} hint="Leads you answered before they expired" />
        <Stat label="Trust score" value={b.trustScore} hint={<TrustBadge tier={b.verificationTier} badgeActive={b.badgeActive} />} />
      </div>
      {!leads.ok || !balance.ok ? <Alert tone="danger">Some numbers could not be loaded. Refresh in a moment.</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Verification</CardTitle></CardHeader>
          <CardBody className="space-y-3">
            <ul className="space-y-2">
              {ladder.map((t) => (
                <li key={t.label} className="flex items-center gap-2 text-sm text-ink">
                  {t.done ? <CheckCircle2 className="size-4 text-success" aria-hidden /> : <Circle className="size-4 text-muted" aria-hidden />}
                  <span className={t.done ? "" : "text-muted"}>{t.label}</span>
                  <span className="sr-only">{t.done ? "done" : "not done"}</span>
                </li>
              ))}
            </ul>
            {b.verificationTier < 1 ? <Link href="/verification" className={buttonClasses("primary", "md", "min-h-11")}>Verify GST</Link> : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>What improves your trust score</CardTitle></CardHeader>
          <CardBody>
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink">{IMPROVES.map((i) => <li key={i}>{i}</li>)}</ul>
            <p className="mt-3 text-xs text-muted">Paying for a plan never changes your score, badge or rank.</p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
