import type { DomainView } from "@cnote/domains";
import { Alert, Badge, Card, CardBody, type BadgeTone } from "@cnote/ui";
import { CopyButton } from "./copy-button";
import { DomainActions } from "./domain-actions";

const STATUS: Record<string, { label: string; tone: BadgeTone; help: string }> = {
  pending_dns: { label: "Waiting for DNS", tone: "warning", help: "Add the records below at your domain provider. Changes can take from a few minutes to a few hours to spread." },
  verifying: { label: "Checking", tone: "neutral", help: "We are checking your DNS records now." },
  verified: { label: "DNS verified", tone: "brand", help: "Your records are correct. We are setting up secure access (HTTPS)." },
  provisioning_tls: { label: "Issuing certificate", tone: "brand", help: "Your records are correct. Your HTTPS certificate is being issued, usually within a few minutes." },
  active: { label: "Active", tone: "success", help: "Your domain is live and serving your storefront over HTTPS." },
  misconfigured: { label: "Needs attention", tone: "danger", help: "Something is wrong with this domain. See what we found below, fix it, then press Check again." },
};
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : "not yet");
const ok = (v: boolean) => (v ? <span className="text-success">Matches</span> : <span className="text-danger">Does not match</span>);

export function isInProgress(s: string) {
  return s === "pending_dns" || s === "verifying" || s === "verified" || s === "provisioning_tls";
}

export function DomainCard({ d }: { d: DomainView }) {
  const st = STATUS[d.status] ?? { label: d.status, tone: "neutral" as BadgeTone, help: "" };
  const dns = d.diagnostics?.dns;
  const all = [...d.records, ...d.providerRecords];
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-all text-lg font-semibold text-ink">{d.hostname}</h2>
          <Badge tone={st.tone}>{st.label}</Badge>
          {d.isPrimary ? <Badge tone="accent">Primary</Badge> : null}
          {d.url ? <a href={d.url} className="text-sm font-medium text-brand-700 hover:underline" target="_blank" rel="noreferrer">Visit<span className="sr-only"> {d.hostname} (opens in a new tab)</span></a> : null}
        </div>
        <p className="text-sm text-muted">{st.help}</p>
        {d.lastError && d.status !== "active" ? <Alert tone={d.status === "misconfigured" ? "danger" : "warning"}>{d.lastError}</Alert> : null}

        {d.status !== "active" ? (
          <section aria-label={`DNS records for ${d.hostname}`} className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Add these DNS records</h3>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                <caption className="sr-only">DNS records to add for {d.hostname}</caption>
                <thead>
                  <tr className="bg-canvas text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-3 py-2">Type</th>
                    <th scope="col" className="px-3 py-2">Name</th>
                    <th scope="col" className="px-3 py-2">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((r, i) => (
                    <tr key={`${r.type}-${r.name}-${r.value}-${i}`} className="border-t border-line align-top">
                      <th scope="row" className="px-3 py-2 font-mono text-xs font-semibold">{r.type}</th>
                      <td className="px-3 py-2"><div className="flex flex-wrap items-center gap-2"><code className="break-all font-mono text-xs">{r.name}</code><CopyButton value={r.name} label={`${r.type} name`} /></div></td>
                      <td className="px-3 py-2"><div className="flex flex-wrap items-center gap-2"><code className="break-all font-mono text-xs">{r.value}</code><CopyButton value={r.value} label={`${r.type} value`} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.note ? <p className="text-xs text-muted">{d.note}</p> : null}
            <p className="text-xs text-muted">Most providers want the name without your domain at the end, for example <code>www</code> instead of <code>www.example.com</code>. Remove any old A or AAAA records on the same name first.</p>
          </section>
        ) : null}

        {dns ? (
          <section aria-label="What we see" className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">What we see <span className="font-normal text-muted">(checked {fmt(d.lastCheckedAt)})</span></h3>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                <caption className="sr-only">Comparison of expected and observed DNS for {d.hostname}</caption>
                <thead>
                  <tr className="bg-canvas text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-3 py-2">Check</th>
                    <th scope="col" className="px-3 py-2">We expect</th>
                    <th scope="col" className="px-3 py-2">We found</th>
                    <th scope="col" className="px-3 py-2">Result</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-line align-top">
                    <th scope="row" className="px-3 py-2 font-medium">Ownership (TXT)</th>
                    <td className="break-all px-3 py-2 font-mono text-xs">{dns.txt.expected}</td>
                    <td className="break-all px-3 py-2 font-mono text-xs">{dns.txt.observed.join(", ") || "nothing"}</td>
                    <td className="px-3 py-2">{ok(dns.txt.ok)}</td>
                  </tr>
                  <tr className="border-t border-line align-top">
                    <th scope="row" className="px-3 py-2 font-medium">{dns.routing.mode === "cname" ? "Routing (CNAME)" : "Routing (A)"}</th>
                    <td className="break-all px-3 py-2 font-mono text-xs">{dns.routing.expected.join(", ") || "n/a"}</td>
                    <td className="break-all px-3 py-2 font-mono text-xs">{[...dns.routing.observedCname, ...dns.routing.observedA].join(", ") || "nothing"}</td>
                    <td className="px-3 py-2">{ok(dns.routing.ok)}</td>
                  </tr>
                  {d.diagnostics?.probe && !d.diagnostics.probe.skipped ? (
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="px-3 py-2 font-medium">HTTPS reachability</th>
                      <td className="px-3 py-2 text-xs">Our servers answer at your domain</td>
                      <td className="px-3 py-2 text-xs">{d.diagnostics.probe.ok ? "Reached our servers" : (d.diagnostics.probe.error ?? "Not reachable")}</td>
                      <td className="px-3 py-2">{ok(d.diagnostics.probe.ok)}</td>
                    </tr>
                  ) : null}
                  {d.diagnostics?.edge ? (
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="px-3 py-2 font-medium">Certificate (HTTPS)</th>
                      <td className="px-3 py-2 text-xs">Issued</td>
                      <td className="px-3 py-2 text-xs">{d.diagnostics.edge.state === "active" ? "Issued" : d.diagnostics.edge.state === "pending" ? "Being issued" : (d.diagnostics.edge.error ?? "Failed")}</td>
                      <td className="px-3 py-2">{ok(d.diagnostics.edge.state === "active")}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            {dns.caa.warning ? <Alert tone="warning">{dns.caa.warning}</Alert> : null}
          </section>
        ) : null}

        <DomainActions id={d.id} hostname={d.hostname} status={d.status} isPrimary={d.isPrimary} />
      </CardBody>
    </Card>
  );
}
