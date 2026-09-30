import { getResidencyReport } from "@cnote/compliance";
import { Alert, Badge } from "@cnote/ui";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";

export const metadata = { title: "Data residency" };
export const dynamic = "force-dynamic";

const TONE = { ok: "success", warn: "warning", violation: "danger" } as const;

export default async function ResidencyPage() {
  await requireStaff("/compliance/residency", "compliance.read");
  const report = getResidencyReport();
  return (
    <div className="space-y-4">
      <Alert tone={report.ok ? "success" : "danger"}>
        {report.ok ? "All checked endpoints are in India (or private/local)." : "One or more endpoints are outside India or cannot be pinned to India."}{" "}
        Enforcement at startup is {report.enforce ? "ON" : "OFF"} (DATA_RESIDENCY_ENFORCE). This panel reflects the configuration of the admin app process; other apps and the worker have their own environment.
      </Alert>
      <Table>
        <thead><tr><Th>Component</Th><Th>Host / region</Th><Th>Status</Th><Th>Note</Th></tr></thead>
        <tbody>
          {report.checks.map((c) => (
            <tr key={c.name}>
              <Td>{c.name}</Td>
              <Td><code className="text-xs">{c.value}</code></Td>
              <Td><Badge tone={TONE[c.status]}>{c.status}</Badge></Td>
              <Td className="text-muted">{c.note}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
