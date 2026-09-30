import type { DomainView } from "@cnote/domains";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, type BadgeTone } from "@cnote/ui";
import { type Locale, intlTag } from "@/i18n/config";
import { CopyButton } from "./copy-button";
import { DomainActions } from "./domain-actions";

const STATUS_TONE = { pending_dns: "warning", verifying: "neutral", verified: "brand", provisioning_tls: "brand", active: "success", misconfigured: "danger" } as const satisfies Record<string, BadgeTone>;
type KnownStatus = keyof typeof STATUS_TONE;
const isKnown = (s: string): s is KnownStatus => s in STATUS_TONE;

export function isInProgress(s: string) {
  return s === "pending_dns" || s === "verifying" || s === "verified" || s === "provisioning_tls";
}

export async function DomainCard({ d }: { d: DomainView }) {
  const t = await getTranslations("storefront.card");
  const locale = (await getLocale()) as Locale;
  const st: { label: string; tone: BadgeTone; help: string } = isKnown(d.status)
    ? { label: t(`status.${d.status}.label`), tone: STATUS_TONE[d.status], help: t(`status.${d.status}.help`) }
    : { label: d.status, tone: "neutral", help: "" };
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(intlTag(locale), { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }) : t("notYet"));
  const ok = (v: boolean) => (v ? <span className="text-success">{t("matches")}</span> : <span className="text-danger">{t("noMatch")}</span>);
  const dns = d.diagnostics?.dns;
  const all = [...d.records, ...d.providerRecords];
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="break-all text-lg font-semibold text-ink">{d.hostname}</h2>
          <Badge tone={st.tone}>{st.label}</Badge>
          {d.isPrimary ? <Badge tone="accent">{t("primary")}</Badge> : null}
          {d.url ? <a href={d.url} className="text-sm font-medium text-brand-700 hover:underline" target="_blank" rel="noreferrer">{t("visit")}<span className="sr-only"> {t("visitSr", { host: d.hostname })}</span></a> : null}
        </div>
        <p className="text-sm text-muted">{st.help}</p>
        {d.lastError && d.status !== "active" ? <Alert tone={d.status === "misconfigured" ? "danger" : "warning"}>{d.lastError}</Alert> : null}

        {d.status !== "active" ? (
          <section aria-label={t("dnsAria", { host: d.hostname })} className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">{t("addRecords")}</h3>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                <caption className="sr-only">{t("recordsCaption", { host: d.hostname })}</caption>
                <thead>
                  <tr className="bg-canvas text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-3 py-2">{t("colType")}</th>
                    <th scope="col" className="px-3 py-2">{t("colName")}</th>
                    <th scope="col" className="px-3 py-2">{t("colValue")}</th>
                  </tr>
                </thead>
                <tbody>
                  {all.map((r, i) => (
                    <tr key={`${r.type}-${r.name}-${r.value}-${i}`} className="border-t border-line align-top">
                      <th scope="row" className="px-3 py-2 font-mono text-xs font-semibold">{r.type}</th>
                      <td className="px-3 py-2"><div className="flex flex-wrap items-center gap-2"><code className="break-all font-mono text-xs">{r.name}</code><CopyButton value={r.name} label={t("copyName", { type: r.type })} /></div></td>
                      <td className="px-3 py-2"><div className="flex flex-wrap items-center gap-2"><code className="break-all font-mono text-xs">{r.value}</code><CopyButton value={r.value} label={t("copyValue", { type: r.type })} /></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.note ? <p className="text-xs text-muted">{d.note}</p> : null}
            <p className="text-xs text-muted">{t.rich("nameHint", { code: (c) => <code>{c}</code> })}</p>
          </section>
        ) : null}

        {dns ? (
          <section aria-label={t("seeTitle")} className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">{t("seeTitle")} <span className="font-normal text-muted">{t("checked", { when: fmt(d.lastCheckedAt) })}</span></h3>
            <div className="overflow-x-auto rounded-lg border border-line">
              <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
                <caption className="sr-only">{t("compareCaption", { host: d.hostname })}</caption>
                <thead>
                  <tr className="bg-canvas text-xs uppercase tracking-wide text-muted">
                    <th scope="col" className="px-3 py-2">{t("colCheck")}</th>
                    <th scope="col" className="px-3 py-2">{t("colExpect")}</th>
                    <th scope="col" className="px-3 py-2">{t("colFound")}</th>
                    <th scope="col" className="px-3 py-2">{t("colResult")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-line align-top">
                    <th scope="row" className="px-3 py-2 font-medium">{t("ownership")}</th>
                    <td className="break-all px-3 py-2 font-mono text-xs">{dns.txt.expected}</td>
                    <td className="break-all px-3 py-2 font-mono text-xs">{dns.txt.observed.join(", ") || t("nothing")}</td>
                    <td className="px-3 py-2">{ok(dns.txt.ok)}</td>
                  </tr>
                  <tr className="border-t border-line align-top">
                    <th scope="row" className="px-3 py-2 font-medium">{dns.routing.mode === "cname" ? t("routingCname") : t("routingA")}</th>
                    <td className="break-all px-3 py-2 font-mono text-xs">{dns.routing.expected.join(", ") || t("na")}</td>
                    <td className="break-all px-3 py-2 font-mono text-xs">{[...dns.routing.observedCname, ...dns.routing.observedA].join(", ") || t("nothing")}</td>
                    <td className="px-3 py-2">{ok(dns.routing.ok)}</td>
                  </tr>
                  {d.diagnostics?.probe && !d.diagnostics.probe.skipped ? (
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="px-3 py-2 font-medium">{t("httpsReach")}</th>
                      <td className="px-3 py-2 text-xs">{t("serversAnswer")}</td>
                      <td className="px-3 py-2 text-xs">{d.diagnostics.probe.ok ? t("reached") : (d.diagnostics.probe.error ?? t("notReachable"))}</td>
                      <td className="px-3 py-2">{ok(d.diagnostics.probe.ok)}</td>
                    </tr>
                  ) : null}
                  {d.diagnostics?.edge ? (
                    <tr className="border-t border-line align-top">
                      <th scope="row" className="px-3 py-2 font-medium">{t("cert")}</th>
                      <td className="px-3 py-2 text-xs">{t("issued")}</td>
                      <td className="px-3 py-2 text-xs">{d.diagnostics.edge.state === "active" ? t("issued") : d.diagnostics.edge.state === "pending" ? t("beingIssued") : (d.diagnostics.edge.error ?? t("failed"))}</td>
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
