import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Alert, EmptyState, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { billing, enquiry } from "@/lib/services";
import { LeadCard } from "@/features/leads/lead-card";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getTranslations("leads"))("metaTitle") };
}

export default async function LeadsPage() {
  const session = await requireSeller("/leads");
  const t = await getTranslations("leads");
  const [leads, balance] = await Promise.all([load(() => enquiry.listSellerLeads(session.business.id)), load(() => billing.getBalance(session.business.id))]);
  const credits = balance.ok ? balance.data : null;

  if (!leads.ok) return <div className="space-y-6"><PageHeader title={t("title")} /><Alert tone="danger">{leads.error}</Alert></div>;

  const open = leads.data.filter((l) => l.status === "offered");
  const accepted = leads.data.filter((l) => l.status === "accepted");
  const other = leads.data.filter((l) => !["offered", "accepted"].includes(l.status));

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<Link href="/billing" className={buttonClasses("outline", "md", "min-h-11")}>{credits === null ? t("creditsFallback") : t("creditsButton", { count: credits })}</Link>}
      />

      <section aria-labelledby="open" className="space-y-3">
        <h2 id="open" className="text-lg font-bold text-ink">{t("openHeading", { count: open.length })}</h2>
        {open.length === 0 ? (
          <EmptyState title={t("emptyTitle")} description={t("emptyDescription")} action={<Link href="/listings" className={buttonClasses("primary", "md", "min-h-11")}>{t("emptyAction")}</Link>} />
        ) : (
          <ul className="grid gap-4">{open.map((l) => <li key={l.matchId}><LeadCard lead={l} balance={credits} /></li>)}</ul>
        )}
      </section>

      {accepted.length ? (
        <section aria-labelledby="accepted" className="space-y-3">
          <h2 id="accepted" className="text-lg font-bold text-ink">{t("acceptedHeading", { count: accepted.length })}</h2>
          <ul className="grid gap-4">{accepted.map((l) => <li key={l.matchId}><LeadCard lead={l} balance={credits} /></li>)}</ul>
        </section>
      ) : null}

      {other.length ? (
        <section aria-labelledby="closed" className="space-y-3">
          <h2 id="closed" className="text-lg font-bold text-ink">{t("closedHeading", { count: other.length })}</h2>
          <ul className="grid gap-4">{other.map((l) => <li key={l.matchId}><LeadCard lead={l} balance={credits} /></li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}
