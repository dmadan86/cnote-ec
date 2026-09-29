import { type AuditFilters, listAuditLog } from "@cnote/admin";
import { Alert, Badge, Button, EmptyState, Input, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { ZodError } from "zod";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, json, one } from "@/lib/util";

export const metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  const { ctx } = await requireStaff("/audit", "audit.read");
  const sp = await searchParams;
  const f = {
    action: one(sp.action), privilege: one(sp.privilege), subjectType: one(sp.subjectType), subjectId: one(sp.subjectId), staffId: one(sp.staffId),
    from: one(sp.from), to: one(sp.to),
  };
  const cursor = one(sp.cursor);
  let data: Awaited<ReturnType<typeof listAuditLog>> | null = null;
  let problem: string | null = null;
  try {
    const filters: AuditFilters = {
      ...f,
      from: f.from ? new Date(`${f.from}T00:00:00+05:30`) : undefined,
      to: f.to ? new Date(`${f.to}T23:59:59.999+05:30`) : undefined,
      cursor,
      limit: 50,
    };
    data = await listAuditLog(ctx, filters);
  } catch (e) {
    if (e instanceof ZodError) problem = "One of the filters is invalid.";
    else throw e;
  }
  const qs = (extra: Record<string, string>) => new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>, ...extra }).toString();
  return (
    <>
      <PageHeader title="Audit log" description="Append-only record of every privileged action, including denied and failed attempts. Times in IST. Action supports a trailing * wildcard." />
      <form className="flex flex-wrap items-end gap-2" role="search">
        <Input name="action" defaultValue={f.action} placeholder="action e.g. review.*" className="w-48" aria-label="Action" />
        <Input name="privilege" defaultValue={f.privilege} placeholder="privilege" className="w-40" aria-label="Privilege" />
        <Input name="subjectType" defaultValue={f.subjectType} placeholder="subject type" className="w-36" aria-label="Subject type" />
        <Input name="subjectId" defaultValue={f.subjectId} placeholder="subject id" className="w-48" aria-label="Subject id" />
        <Input name="staffId" defaultValue={f.staffId} placeholder="staff id" className="w-48" aria-label="Staff id" />
        <Input type="date" name="from" defaultValue={f.from} className="w-40" aria-label="From date" />
        <Input type="date" name="to" defaultValue={f.to} className="w-40" aria-label="To date" />
        <Button type="submit" variant="outline">Filter</Button>
        <Link href="/audit" className="px-2 text-sm text-muted hover:underline">Reset</Link>
      </form>
      {problem ? <Alert tone="danger">{problem}</Alert> : data && data.items.length === 0 ? <EmptyState title="No matching entries" /> : data ? (
        <>
          <Table>
            <thead><tr><Th>When</Th><Th>Staff</Th><Th>Action</Th><Th>Privilege</Th><Th>Subject</Th><Th>Result</Th><Th>Details</Th></tr></thead>
            <tbody>
              {data.items.map((e) => {
                const failed = !!e.details.error, denied = !!e.details.denied;
                return (
                  <tr key={e.id}>
                    <Td className="whitespace-nowrap">{fmtDate(e.createdAt)}</Td>
                    <Td>{e.staffId ? <Mono>{e.staffId.slice(0, 8)}</Mono> : <span className="text-muted">system/CLI</span>}</Td>
                    <Td><Mono>{e.action}</Mono></Td>
                    <Td>{e.privilege}</Td>
                    <Td>{e.subjectType ? <>{e.subjectType} <Mono>{e.subjectId?.slice(0, 12) ?? ""}</Mono></> : "—"}</Td>
                    <Td><Badge tone={denied ? "warning" : failed ? "danger" : "success"}>{denied ? "denied" : failed ? "failed" : "ok"}</Badge></Td>
                    <Td>
                      <details><summary className="cursor-pointer text-brand-700">view</summary>
                        <pre className="mt-1 max-w-md overflow-auto text-xs">{json({ ...e.details, ip: e.ip, userAgent: e.userAgent }, 1500)}</pre>
                      </details>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          {data.nextCursor ? <Link href={`/audit?${qs({ cursor: data.nextCursor })}`} className="text-sm text-brand-700 hover:underline">Older entries →</Link> : null}
        </>
      ) : null}
    </>
  );
}
