import { hasPrivilege } from "@cnote/admin";
import { listContacts, listInboundDeadLetters } from "@cnote/whatsapp";
import { Alert, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";
import { ResetButton, RetryButton } from "./buttons";

export const metadata = { title: "WhatsApp" };
const STEPS = ["language", "consent", "business_name", "location", "media", "collecting", "processing", "review", "done", "declined"];

export default async function WhatsAppPage({ searchParams }: PageProps<"/whatsapp">) {
  const { staff } = await requireStaff("/whatsapp", "businesses.read");
  const sp = await searchParams;
  const step = STEPS.find((s) => s === one(sp.step));
  const canAct = hasPrivilege(staff, "businesses.verify");
  const [contacts, dead] = await Promise.all([
    safe("whatsapp.listContacts", () => listContacts({ step })),
    safe("whatsapp.deadLetters", () => listInboundDeadLetters(50)),
  ]);
  return (
    <>
      <PageHeader title="WhatsApp conversations" description="Seller onboarding over WhatsApp. Phone numbers are never stored on the conversation (only a hash), so contacts show a short reference. Message text is redacted and purged after 30 days." />
      <nav aria-label="Filter by step" className="flex flex-wrap gap-2 text-sm">
        <Link href="/whatsapp" className={!step ? "font-semibold text-brand-700" : "text-brand-700 hover:underline"}>All</Link>
        {STEPS.map((s) => (
          <Link key={s} href={`/whatsapp?step=${s}`} className={step === s ? "font-semibold text-brand-700" : "text-brand-700 hover:underline"}>{s}</Link>
        ))}
      </nav>
      {!canAct ? <Alert tone="info">You can inspect conversations but your role cannot reset them or retry failed messages.</Alert> : null}
      {contacts === null ? <Alert tone="warning">Conversations are currently unavailable.</Alert> : contacts.length === 0 ? <EmptyState title="No conversations" /> : (
        <Table>
          <thead><tr><Th>Contact</Th><Th>Step</Th><Th>Language</Th><Th>Consent</Th><Th>24h window</Th><Th>Failed sends</Th><Th>Updated</Th><Th /></tr></thead>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id}>
                <Td><Mono>{c.ref}</Mono>{c.optedOut ? <span className="ml-2 rounded bg-canvas px-1.5 text-xs text-muted">opted out</span> : null}</Td>
                <Td>{c.step ?? "—"}</Td>
                <Td>{c.language}</Td>
                <Td>{c.consented ? "Yes" : "No"}</Td>
                <Td>{c.windowOpen ? "Open" : "Closed"}</Td>
                <Td>{c.failedSends}</Td>
                <Td className="whitespace-nowrap">{fmtDate(c.updatedAt)}</Td>
                <Td className="text-right whitespace-nowrap">
                  <Link href={`/whatsapp/${c.id}`} className="mr-3 font-medium text-brand-700 hover:underline">Messages</Link>
                  {canAct ? <ResetButton id={c.id} /> : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <h2 className="mt-6 text-lg font-semibold">Failed inbound jobs</h2>
      {dead === null ? <Alert tone="warning">The queue is currently unavailable.</Alert> : dead.length === 0 ? <EmptyState title="Nothing failed" description="Every inbound message was processed." /> : (
        <Table>
          <thead><tr><Th>Job</Th><Th>Kind</Th><Th>Attempts</Th><Th>Enqueued</Th>{canAct ? <Th /> : null}</tr></thead>
          <tbody>
            {dead.map((d) => (
              <tr key={d.id}>
                <Td><Mono>{d.id}</Mono></Td>
                <Td>{d.kind} ({d.summary})</Td>
                <Td>{d.attempt}</Td>
                <Td className="whitespace-nowrap">{fmtDate(d.enqueuedAt)}</Td>
                {canAct ? <Td className="text-right"><RetryButton id={d.id} /></Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
