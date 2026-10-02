import { audited } from "@cnote/admin";
import { COOKIE_CONSENT_ACTIONS, COOKIE_CONSENT_APPS, cookieConsentStats, searchCookieConsentReceipts, type CookieConsentStats } from "@cnote/compliance";
import { DomainError } from "@cnote/core";
import { Alert, Badge, Button, Card, CardBody, CardHeader, CardTitle, EmptyState, Input, Select } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { parseConsentFilters } from "@/features/compliance/consent-filters";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";

export const metadata = { title: "Cookie consent log" };

const ACTION_TONE = { accept_all: "success", reject_all: "neutral", custom: "brand", withdraw: "warning" } as const;
const pct = (n: number) => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;

function StatsView({ stats }: { stats: CookieConsentStats }) {
  const max = Math.max(1, ...stats.daily.map((d) => d.total));
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle>Action mix per day (IST)</CardTitle></CardHeader>
        <CardBody>
          {stats.daily.length === 0 ? <p className="text-sm text-muted">No receipts in this range.</p> : (
            <Table>
              <caption className="sr-only">Cookie consent actions per day</caption>
              <thead><tr><Th>Day</Th><Th>Accept all</Th><Th>Reject all</Th><Th>Custom</Th><Th>Withdraw</Th><Th>Total</Th><Th><span className="sr-only">Share</span></Th></tr></thead>
              <tbody>
                {stats.daily.slice().reverse().map((d) => (
                  <tr key={d.day}>
                    <Td className="whitespace-nowrap">{d.day}</Td><Td>{d.accept_all}</Td><Td>{d.reject_all}</Td><Td>{d.custom}</Td><Td>{d.withdraw}</Td><Td>{d.total}</Td>
                    <Td className="w-40">
                      <div className="flex h-2 overflow-hidden rounded bg-canvas" aria-hidden="true" style={{ width: `${Math.max(4, (d.total / max) * 100)}%` }}>
                        <span className="bg-success" style={{ width: `${(d.accept_all / d.total) * 100}%` }} />
                        <span className="bg-muted" style={{ width: `${(d.reject_all / d.total) * 100}%` }} />
                        <span className="bg-brand-600" style={{ width: `${(d.custom / d.total) * 100}%` }} />
                        <span className="bg-warning" style={{ width: `${(d.withdraw / d.total) * 100}%` }} />
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardBody>
      </Card>
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader><CardTitle>Global Privacy Control</CardTitle></CardHeader>
          <CardBody className="text-sm">
            <p className="text-3xl font-semibold text-ink">{pct(stats.gpc.share)}</p>
            <p className="text-muted">{stats.gpc.withGpc} of {stats.gpc.total} receipts were made with GPC on (marketing is never pre-granted for them; GPC does not affect preferences/functional).</p>
            <p className="mt-2 text-muted">Choices with each category on: analytics {stats.granted.analytics}, marketing {stats.granted.marketing}, preferences {stats.granted.functional} (of {stats.total}).</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>By language</CardTitle></CardHeader>
          <CardBody>
            {stats.byLocale.length === 0 ? <p className="text-sm text-muted">No receipts in this range.</p> : (
              <Table>
                <caption className="sr-only">Cookie consent actions per notice language</caption>
                <thead><tr><Th>Lang</Th><Th>Accept</Th><Th>Reject</Th><Th>Custom</Th><Th>Withdraw</Th></tr></thead>
                <tbody>
                  {stats.byLocale.map((l) => (
                    <tr key={l.locale}><Td>{l.locale}</Td><Td>{pct(l.accept_all / l.total)}</Td><Td>{pct(l.reject_all / l.total)}</Td><Td>{pct(l.custom / l.total)}</Td><Td>{pct(l.withdraw / l.total)}</Td></tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export default async function ConsentLogPage({ searchParams }: PageProps<"/compliance/consent">) {
  const { ctx } = await requireStaff("/compliance/consent", "compliance.consent");
  const sp = await searchParams;
  const raw = { q: one(sp.q), from: one(sp.from), to: one(sp.to), v: one(sp.v), action: one(sp.action), app: one(sp.app) };
  const cursor = one(sp.cursor);
  const { filters, problem: filterProblem } = parseConsentFilters(raw);

  let page: Awaited<ReturnType<typeof searchCookieConsentReceipts>> | null = null;
  let problem = filterProblem;
  if (!problem) {
    try {
      // Every search is audited: a result can carry a person id (personal-data adjacent).
      page = await audited(ctx, "compliance.consent", "consent.search", { type: "CookieConsentReceipt" }, () => searchCookieConsentReceipts({ ...filters, cursor, limit: 50 }), {
        q: filters.q ?? null, from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null, policyVersion: filters.policyVersion ?? null, action: filters.action ?? null, app: filters.app ?? null, paged: !!cursor,
      });
    } catch (e) {
      if (e instanceof DomainError && e.code === "validation") problem = e.message;
      else throw e;
    }
  }
  const stats = filterProblem ? null : await safe("compliance.cookieConsentStats", () => cookieConsentStats({ from: filters.from, to: filters.to, policyVersion: filters.policyVersion }));

  const base = Object.fromEntries(Object.entries(raw).filter(([, v]) => v)) as Record<string, string>;
  const qs = (extra: Record<string, string> = {}) => new URLSearchParams({ ...base, ...extra }).toString();
  return (
    <>
      <p className="text-sm text-muted">
        Append-only proof of every cookie choice on the buyer site and the seller app (DPDP s.6(10)); policy versions are per app. Search by consent ID (32 hex) or person ID. A receipt holds no IP address or browser details. Times in IST.
        Searching and exporting are audited.
      </p>
      {stats ? <StatsView stats={stats} /> : stats === null && !filterProblem ? <Alert tone="warning">Summary metrics are currently unavailable.</Alert> : null}
      <form className="flex flex-wrap items-end gap-2" role="search" aria-label="Search consent receipts">
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">Consent ID or person ID<Input name="q" defaultValue={raw.q} className="w-80 font-mono" placeholder="32 hex characters or a person UUID" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">From<Input type="date" name="from" defaultValue={raw.from} className="w-40" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">To<Input type="date" name="to" defaultValue={raw.to} className="w-40" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">App
          <Select name="app" defaultValue={raw.app ?? ""} className="w-32">
            <option value="">Any</option>
            {COOKIE_CONSENT_APPS.map((a) => <option key={a} value={a}>{a}</option>)}
          </Select>
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">Policy version<Input type="number" min={1} name="v" defaultValue={raw.v} className="w-28" /></label>
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">Action
          <Select name="action" defaultValue={raw.action ?? ""} className="w-40">
            <option value="">Any</option>
            {COOKIE_CONSENT_ACTIONS.map((a) => <option key={a} value={a}>{a.replace("_", " ")}</option>)}
          </Select>
        </label>
        <Button type="submit" variant="outline">Search</Button>
        <Link href="/compliance/consent" className="px-2 text-sm text-muted hover:underline">Reset</Link>
        {!problem ? <a href={`/compliance/consent/export${qs() ? `?${qs()}` : ""}`} className="ml-auto text-sm font-medium text-brand-700 hover:underline" download>Export CSV</a> : null}
      </form>
      {problem ? <Alert tone="danger">{problem}</Alert> : page && page.items.length === 0 ? <EmptyState title="No matching receipts" description="Nothing matches these filters." /> : page ? (
        <>
          <Table>
            <caption className="sr-only">Cookie consent receipts, newest first</caption>
            <thead><tr><Th>Recorded</Th><Th>Action</Th><Th>Analytics</Th><Th>Marketing</Th><Th>Functional</Th><Th>GPC</Th><Th>App</Th><Th>Policy</Th><Th>Lang</Th><Th>Consent ID</Th><Th>Person</Th></tr></thead>
            <tbody>
              {page.items.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{fmtDate(r.createdAt)}</Td>
                  <Td><Badge tone={ACTION_TONE[r.action]}>{r.action.replace("_", " ")}</Badge></Td>
                  <Td>{r.analytics ? "On" : "Off"}</Td>
                  <Td>{r.marketing ? "On" : "Off"}</Td>
                  <Td>{r.functional ? "On" : "Off"}</Td>
                  <Td>{r.gpc ? "Yes" : "No"}</Td>
                  <Td>{r.app}</Td>
                  <Td className="whitespace-nowrap">v{r.policyVersion}{r.registryHash ? <> <Mono>{r.registryHash.slice(0, 8)}</Mono></> : null}</Td>
                  <Td>{r.locale}</Td>
                  <Td><Link href={`/compliance/consent?${new URLSearchParams({ q: r.consentId }).toString()}`} className="hover:underline"><Mono>{r.consentId}</Mono></Link></Td>
                  <Td>{r.personId ? <Link href={`/compliance/consent?${new URLSearchParams({ q: r.personId }).toString()}`} className="hover:underline"><Mono>{shortId(r.personId)}</Mono></Link> : <span className="text-muted">anonymous</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {page.nextCursor ? <Link href={`/compliance/consent?${qs({ cursor: page.nextCursor })}`} className="text-sm text-brand-700 hover:underline">Older receipts →</Link> : null}
        </>
      ) : null}
    </>
  );
}
