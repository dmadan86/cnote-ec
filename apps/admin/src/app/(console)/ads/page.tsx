import { getKillSwitches, getRevenueCapStatus, isAdsEnabled, listCampaignsForAdmin, listReviewQueue } from "@cnote/ads";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, PageHeader, Stat } from "@cnote/ui";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { safe } from "@/lib/util";
import { AdsNav } from "./ads-nav";
import { KillSwitchForm } from "./forms";

export const metadata = { title: "Ads" };

const inr = (p: number) => `₹${(p / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export default async function AdsHome() {
  const { staff } = await requireStaff("/ads", "ads.read");
  const [cap, kills, queue, live] = await Promise.all([
    safe("ads.revenueCap", () => getRevenueCapStatus()),
    safe("ads.kill", () => getKillSwitches()),
    safe("ads.queue", () => listReviewQueue(200)),
    safe("ads.campaigns", () => listCampaignsForAdmin({ limit: 300 })),
  ]);
  const enabled = isAdsEnabled();
  const running = live?.filter((c) => c.status === "active").length ?? 0;
  return (
    <>
      <PageHeader title="Ads" description="Sponsored products (ADR-024). Organic ranking is never touched by anything here." />
      <AdsNav active="/ads" />
      <Alert tone={enabled ? "success" : "warning"}>
        {enabled ? "ADS_ENABLED is on: sponsored slots are being served." : "ADS_ENABLED is off: nothing is served and sellers see \"coming soon\". You can still configure rates, settings and review campaigns."}
      </Alert>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Awaiting review" value={queue?.length ?? "-"} />
        <Stat label="Running campaigns" value={running} />
        <Stat label="All campaigns" value={live?.length ?? "-"} />
      </div>

      <section aria-labelledby="cap" className="space-y-2">
        <h2 id="cap" className="text-sm font-semibold uppercase tracking-wide text-muted">Ad revenue cap (trailing 90 days)</h2>
        {cap === null ? <Alert tone="warning">Revenue data is unavailable.</Alert> : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Ad share of revenue" value={`${cap.sharePct}%`} hint={`Cap ${cap.capPct}%`} />
              <Stat label="Ad revenue" value={inr(cap.adRevenuePaise)} hint="Settled click spend, ex-GST" />
              <Stat label="Other revenue" value={inr(cap.otherRevenuePaise)} hint="Subscriptions and credit packs" />
              <Stat label="Status" value={cap.breached ? <Badge tone="danger">Over cap</Badge> : <Badge tone="success">Within cap</Badge>} />
            </div>
            {cap.breached ? <Alert tone="danger">Ads exceed the agreed share of revenue. This is an alert only: nothing was switched off. A founder decision is required and must be recorded in an ADR (ADR-024 rule 10).</Alert> : null}
          </>
        )}
      </section>

      <section aria-labelledby="kill" className="space-y-2">
        <h2 id="kill" className="text-sm font-semibold uppercase tracking-wide text-muted">Kill switches</h2>
        <p className="text-sm text-muted">Take effect on the next request, no deploy. Every use is audited.</p>
        {kills === null ? <Alert tone="warning">Kill-switch state is unavailable.</Alert> : (
          <Table>
            <thead><tr><Th>Scope</Th><Th>State</Th><Th>{hasPrivilege(staff, "ads.suspend") ? "Action" : ""}</Th></tr></thead>
            <tbody>
              {Object.entries(kills).map(([scope, on]) => (
                <tr key={scope}>
                  <Td className="font-medium">{scope === "all" ? "All ads" : scope}</Td>
                  <Td>{on ? <Badge tone="danger">Switched off</Badge> : <Badge tone="success">Serving</Badge>}</Td>
                  <Td>{hasPrivilege(staff, "ads.suspend") ? <KillSwitchForm scope={scope} on={on} /> : null}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}
