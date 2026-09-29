import { funnelByTriggerDay, type FunnelRow } from "@cnote/leadgen";
import { Alert, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { one, safe } from "@/lib/util";

export const metadata = { title: "Lead funnel" };

const RANGES = [7, 30, 90] as const;
const windowOf = (days: number) => ({ from: new Date(Date.now() - days * 86_400_000), to: new Date(Date.now() + 60_000) });
const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((n / d) * 100)}%`);

function Header() {
  return (
    <thead>
      <tr>
        <Th>Trigger</Th><Th className="text-right">Started</Th><Th className="text-right">Code sent</Th><Th className="text-right">Verified</Th>
        <Th className="text-right">Converted</Th><Th className="text-right">Abandoned</Th><Th className="text-right">Start → verified</Th>
      </tr>
    </thead>
  );
}
function Cells({ r }: { r: Pick<FunnelRow, "started" | "otpSent" | "verified" | "converted" | "abandoned"> }) {
  return (
    <>
      <Td className="text-right tabular-nums">{r.started}</Td><Td className="text-right tabular-nums">{r.otpSent}</Td>
      <Td className="text-right tabular-nums">{r.verified}</Td><Td className="text-right tabular-nums">{r.converted}</Td>
      <Td className="text-right tabular-nums">{r.abandoned}</Td><Td className="text-right tabular-nums">{pct(r.verified, r.started)}</Td>
    </>
  );
}

export default async function LeadgenPage({ searchParams }: PageProps<"/leadgen">) {
  const sp = await searchParams;
  const days = RANGES.find((d) => String(d) === one(sp.days)) ?? 30;
  await requireStaff(`/leadgen?days=${days}`, "leadgen.read");
  const w = windowOf(days);
  const rows = await safe("leadgen.funnel", () => funnelByTriggerDay(w.from, w.to));

  const byTrigger = new Map<string, FunnelRow>();
  for (const r of rows ?? []) {
    const t = byTrigger.get(r.trigger) ?? { day: "", trigger: r.trigger, started: 0, otpSent: 0, verified: 0, converted: 0, abandoned: 0 };
    t.started += r.started; t.otpSent += r.otpSent; t.verified += r.verified; t.converted += r.converted; t.abandoned += r.abandoned;
    byTrigger.set(r.trigger, t);
  }
  return (
    <>
      <PageHeader title="Lead funnel" description="Buyer unlock funnel by trigger. Counts only: no phone numbers or personal data are shown. Days are IST." />
      <LinkTabs label="Date range" items={RANGES.map((d) => ({ href: `/leadgen?days=${d}`, label: `Last ${d} days`, active: d === days }))} />
      {rows === null || rows === undefined ? (
        <Alert tone="warning">The funnel is currently unavailable.</Alert>
      ) : rows.length === 0 ? (
        <EmptyState title="No lead captures in this period" description="Captures appear when buyers open the unlock dialog." />
      ) : (
        <>
          <section aria-labelledby="by-trigger" className="flex flex-col gap-2">
            <h2 id="by-trigger" className="text-base font-bold">By trigger</h2>
            <Table>
              <caption className="sr-only">Funnel totals by trigger, last {days} days</caption>
              <Header />
              <tbody>
                {[...byTrigger.values()].sort((a, b) => b.started - a.started).map((r) => (
                  <tr key={r.trigger}><Td className="font-medium">{r.trigger}</Td><Cells r={r} /></tr>
                ))}
              </tbody>
            </Table>
          </section>
          <section aria-labelledby="by-day" className="flex flex-col gap-2">
            <h2 id="by-day" className="text-base font-bold">By day</h2>
            <Table>
              <caption className="sr-only">Funnel by day and trigger, last {days} days</caption>
              <Header />
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.day}-${r.trigger}`}><Td className="whitespace-nowrap">{r.day} · {r.trigger}</Td><Cells r={r} /></tr>
                ))}
              </tbody>
            </Table>
          </section>
        </>
      )}
    </>
  );
}
