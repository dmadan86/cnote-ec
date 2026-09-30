import { getContactMessages } from "@cnote/whatsapp";
import { Alert, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { z } from "zod";
import { notFound } from "next/navigation";
import { Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";

export const metadata = { title: "WhatsApp conversation" };

export default async function ConversationPage({ params }: PageProps<"/whatsapp/[id]">) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await requireStaff(`/whatsapp/${id}`, "businesses.read");
  const rows = await safe("whatsapp.messages", () => getContactMessages(id, 100));
  return (
    <>
      <PageHeader title="Conversation" description="Most recent 100 messages, newest first. Text is PII-redacted and only kept for 30 days; nothing is shown before the seller consented." />
      <p className="text-sm"><Link href="/whatsapp" className="text-brand-700 hover:underline">← All conversations</Link></p>
      {rows === null ? <Alert tone="warning">Messages are currently unavailable.</Alert> : rows.length === 0 ? <EmptyState title="No messages" /> : (
        <Table>
          <thead><tr><Th>When</Th><Th>Dir</Th><Th>Kind</Th><Th>Text (redacted)</Th><Th>Status</Th><Th>Cost</Th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <Td className="whitespace-nowrap">{fmtDate(m.createdAt)}</Td>
                <Td>{m.direction === "in" ? "In" : "Out"}</Td>
                <Td>{m.template ?? m.kind}</Td>
                <Td className="max-w-md whitespace-pre-wrap">{m.body ?? "—"}</Td>
                <Td>{m.status}</Td>
                <Td>{m.costPaise ? `${(m.costPaise / 100).toFixed(2)} Rs` : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
