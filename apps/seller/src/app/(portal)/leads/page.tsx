import type { Metadata } from "next";
import Link from "next/link";
import { Alert, EmptyState, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { billing, enquiry } from "@/lib/services";
import { LeadCard } from "@/features/leads/lead-card";

export const metadata: Metadata = { title: "Leads" };

export default async function LeadsPage() {
  const session = await requireSeller("/leads");
  const [leads, balance] = await Promise.all([load(() => enquiry.listSellerLeads(session.business.id)), load(() => billing.getBalance(session.business.id))]);
  const credits = balance.ok ? balance.data : null;

  if (!leads.ok) return <div className="space-y-6"><PageHeader title="Leads" /><Alert tone="danger">{leads.error}</Alert></div>;

  const open = leads.data.filter((l) => l.status === "offered");
  const accepted = leads.data.filter((l) => l.status === "accepted");
  const other = leads.data.filter((l) => !["offered", "accepted"].includes(l.status));

  return (
    <div className="space-y-8">
      <PageHeader
        title="Leads"
        description="Each lead goes to at most a few sellers. You pay one credit only when you accept."
        actions={<Link href="/billing" className={buttonClasses("outline", "md", "min-h-11")}>{credits === null ? "Credits" : `${credits} credit${credits === 1 ? "" : "s"}`}</Link>}
      />

      <section aria-labelledby="open" className="space-y-3">
        <h2 id="open" className="text-lg font-bold text-ink">Waiting for your answer ({open.length})</h2>
        {open.length === 0 ? (
          <EmptyState title="No open leads right now" description="New leads that match your listings appear here. More published, detailed listings mean better matches." action={<Link href="/listings" className={buttonClasses("primary", "md", "min-h-11")}>Check your listings</Link>} />
        ) : (
          <ul className="grid gap-4">{open.map((l) => <li key={l.matchId}><LeadCard lead={l} balance={credits} /></li>)}</ul>
        )}
      </section>

      {accepted.length ? (
        <section aria-labelledby="accepted" className="space-y-3">
          <h2 id="accepted" className="text-lg font-bold text-ink">Accepted ({accepted.length})</h2>
          <ul className="grid gap-4">{accepted.map((l) => <li key={l.matchId}><LeadCard lead={l} balance={credits} /></li>)}</ul>
        </section>
      ) : null}

      {other.length ? (
        <section aria-labelledby="closed" className="space-y-3">
          <h2 id="closed" className="text-lg font-bold text-ink">Closed ({other.length})</h2>
          <ul className="grid gap-4">{other.map((l) => <li key={l.matchId}><LeadCard lead={l} balance={credits} /></li>)}</ul>
        </section>
      ) : null}
    </div>
  );
}
