import { EMAIL_STATUSES, listEmailLog } from "@cnote/notifications";
import { Alert, Badge, Button, EmptyState, Field, Input, LinkTabs, PageHeader, Select } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Email delivery log" };

const tone = { queued: "neutral", sending: "brand", sent: "success", failed: "danger", suppressed: "warning" } as const;

const href = (status?: string, template?: string, cursor?: string) => {
  const q = new URLSearchParams();
  if (status) q.set("status", status);
  if (template) q.set("template", template);
  if (cursor) q.set("cursor", cursor);
  const s = q.toString();
  return s ? `/queues/email?${s}` : "/queues/email";
};

export default async function EmailLogPage({ searchParams }: PageProps<"/queues/email">) {
  const sp = await searchParams;
  const status = EMAIL_STATUSES.find((s) => s === one(sp.status));
  const template = one(sp.template)?.slice(0, 100);
  const cursor = one(sp.cursor);
  await requireStaff(href(status, template, cursor), "queues.read");
  const log = await safe("notifications.listEmailLog", () => listEmailLog({ status, template, cursor, limit: 50 }));

  return (
    <>
      <PageHeader title="Email delivery log" description="Every outbound email with its delivery status. Recipients are masked and message bodies are never stored." />
      <LinkTabs label="View" items={[{ href: "/queues", label: "Dead letters", active: false }, { href: "/queues/email", label: "Email delivery log", active: true }]} />
      <form method="get" action="/queues/email" className="flex flex-wrap items-end gap-3">
        <Field label="Status" htmlFor="status">
          <Select id="status" name="status" defaultValue={status ?? ""}>
            <option value="">Any</option>
            {EMAIL_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
        </Field>
        <Field label="Template contains" htmlFor="template">
          <Input id="template" name="template" defaultValue={template ?? ""} placeholder="lead.matched" maxLength={100} />
        </Field>
        <Button type="submit" variant="outline">Filter</Button>
        {status || template ? <Link href="/queues/email" className="pb-2 text-sm font-medium text-brand-700 hover:underline">Clear</Link> : null}
      </form>
      {log === null ? (
        <Alert tone="warning">The delivery log is currently unavailable.</Alert>
      ) : log.items.length === 0 ? (
        <EmptyState title="No emails match" description="Try a different status or template." />
      ) : (
        <Table>
          <thead><tr><Th>When</Th><Th>To</Th><Th>Template</Th><Th>Subject</Th><Th>Status</Th><Th>Attempts</Th><Th>Last error</Th></tr></thead>
          <tbody>
            {log.items.map((m) => (
              <tr key={m.id}>
                <Td className="whitespace-nowrap">{fmtDate(m.createdAt)}</Td>
                <Td><Mono>{m.toMasked}</Mono></Td>
                <Td><Mono>{m.template}</Mono></Td>
                <Td className="max-w-xs">{m.subject}</Td>
                <Td><Badge tone={tone[m.status as keyof typeof tone] ?? "neutral"}>{m.status}</Badge></Td>
                <Td>{m.attempts}</Td>
                <Td className="max-w-xs text-xs text-muted">{m.lastError ?? ""}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {log?.nextCursor ? <Link href={href(status, template, log.nextCursor)} className="text-sm font-medium text-brand-700 hover:underline">Older emails →</Link> : null}
    </>
  );
}
