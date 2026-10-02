import { listCampaignsForAdmin } from "@cnote/ads";
import { hasPrivilege } from "@cnote/admin";
import { Alert, Badge, EmptyState, LinkTabs, PageHeader, type BadgeTone } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe, shortId } from "@/lib/util";
import { AdsNav } from "../ads-nav";
import { SuspendForm, UnsuspendForm } from "../forms";

export const metadata = { title: "Ad campaigns" };
const TONE: Record<string, BadgeTone> = { active: "success", approved: "success", pending_review: "warning", suspended: "danger", rejected: "danger", exhausted: "warning" };
const STATUSES = ["active", "approved", "pending_review", "paused", "exhausted", "suspended", "rejected", "ended", "draft"];

export default async function CampaignsPage({ searchParams }: PageProps<"/ads/campaigns">) {
  const status = one((await searchParams).status);
  const { staff } = await requireStaff("/ads/campaigns", "ads.read");
  const rows = await safe("ads.campaigns", () => listCampaignsForAdmin({ status: STATUSES.includes(status ?? "") ? status : undefined, limit: 200 }));
  const canSuspend = hasPrivilege(staff, "ads.suspend");
  return (
    <>
      <PageHeader title="Ad campaigns" description="Every campaign. Suspend is the kill switch for one campaign: it stops serving immediately." />
      <AdsNav active="/ads/campaigns" />
      <LinkTabs label="Filter by status" items={[{ href: "/ads/campaigns", label: "All", active: !status }, ...STATUSES.map((s) => ({ href: `/ads/campaigns?status=${s}`, label: s.replace("_", " "), active: status === s }))]} />
      {rows === null ? <Alert tone="warning">Campaigns are unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No campaigns" description="Nothing matches this filter." /> : (
        <Table>
          <thead><tr><Th>Campaign</Th><Th>Seller</Th><Th>Status</Th><Th>Halted for</Th><Th>Daily budget</Th><Th>Created</Th>{canSuspend ? <Th>Action</Th> : null}</tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <Td className="font-medium"><Link href={`/ads/review/${c.id}`} className="text-brand-700 hover:underline">{c.name}</Link></Td>
                <Td><Mono>{shortId(c.sellerBusinessId)}</Mono></Td>
                <Td><Badge tone={TONE[c.status] ?? "neutral"}>{c.status.replace("_", " ")}</Badge></Td>
                <Td className="text-xs">{c.haltReason ?? ""}</Td>
                <Td>₹{(c.dailyBudgetPaise / 100).toLocaleString("en-IN")}</Td>
                <Td className="whitespace-nowrap text-xs">{fmtDate(c.createdAt)}</Td>
                {canSuspend ? <Td>{c.status === "suspended" ? <UnsuspendForm campaignId={c.id} /> : !["ended", "rejected", "draft"].includes(c.status) ? <SuspendForm campaignId={c.id} /> : null}</Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
