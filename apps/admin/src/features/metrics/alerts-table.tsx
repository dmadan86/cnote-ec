import type { AlertView } from "@cnote/metrics";
import { Badge } from "@cnote/ui";
import Link from "next/link";
import { Table, Td, Th } from "@/components/table";
import { fmtDate } from "@/lib/util";
import { ResolveAlertButton } from "./resolve-button";

export function AlertsTable({ alerts, canResolve }: { alerts: AlertView[]; canResolve: boolean }) {
  return (
    <Table>
      <caption className="sr-only">Metric alerts</caption>
      <thead>
        <tr><Th>Metric</Th><Th>Day (IST)</Th><Th>Message</Th><Th>Status</Th><Th><span className="sr-only">Actions</span></Th></tr>
      </thead>
      <tbody>
        {alerts.map((a) => (
          <tr key={a.id}>
            <Td className="font-medium"><Link href={`/metrics/${a.metric}`} className="text-brand-700 hover:underline">{a.title}</Link></Td>
            <Td className="whitespace-nowrap">{a.day}</Td>
            <Td>{a.message}</Td>
            <Td>{a.resolvedAt ? <Badge tone="neutral">Resolved {fmtDate(a.resolvedAt)}</Badge> : <Badge tone="danger">Open</Badge>}</Td>
            <Td>{!a.resolvedAt && canResolve ? <ResolveAlertButton id={a.id} label={a.title} /> : null}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
