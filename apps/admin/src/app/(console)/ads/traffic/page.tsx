import { listInvalidTraffic } from "@cnote/ads";
import { Alert, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { safe, shortId } from "@/lib/util";
import { AdsNav } from "../ads-nav";

export const metadata = { title: "Invalid ad traffic" };

export default async function TrafficPage() {
  await requireStaff("/ads/traffic", "ads.fraud.review");
  const rows = await safe("ads.traffic", () => listInvalidTraffic({ days: 7, minClicks: 5 }));
  return (
    <>
      <PageHeader title="Invalid traffic" description="Campaigns with the highest share of invalid, pending or self clicks in the last 7 days. Open one to invalidate clicks in bulk; charges already settled are refunded to the seller automatically." />
      <AdsNav active="/ads/traffic" />
      {rows === null ? <Alert tone="warning">Traffic data is unavailable.</Alert> : rows.length === 0 ? <EmptyState title="Nothing flagged" description="No campaign has enough clicks in the last 7 days to judge." /> : (
        <Table>
          <thead><tr><Th>Campaign</Th><Th>Clicks</Th><Th>Valid</Th><Th>Pending</Th><Th>Invalid</Th><Th>Self</Th><Th>Bad share</Th><Th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.campaignId}>
                <Td><Mono>{shortId(r.campaignId)}</Mono></Td><Td>{r.total}</Td><Td>{r.valid}</Td><Td>{r.pending}</Td><Td>{r.invalid}</Td><Td>{r.selfClicks}</Td>
                <Td className={r.badShare > 0.3 ? "font-bold text-danger" : ""}>{Math.round(r.badShare * 100)}%</Td>
                <Td className="text-right"><Link href={`/ads/traffic/${r.campaignId}`} className="font-medium text-brand-700 hover:underline">Review clicks</Link></Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
