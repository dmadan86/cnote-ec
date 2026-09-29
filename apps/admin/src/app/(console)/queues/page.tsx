import { hasPrivilege } from "@cnote/admin";
import { listDeadLetters, listQueueTopics } from "@cnote/notifications";
import { Alert, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import { Mono, Table, Td, Th } from "@/components/table";
import { ReplayButton } from "@/features/queues/replay-button";
import { requireStaff } from "@/lib/auth";
import { fmtDate, json, one, safe } from "@/lib/util";

export const metadata = { title: "Queues" };

export default async function QueuesPage({ searchParams }: PageProps<"/queues">) {
  const sp = await searchParams;
  const topics = listQueueTopics();
  const topic = topics.find((t) => t.topic === one(sp.topic))?.topic ?? topics[0]!.topic;
  const { staff } = await requireStaff(`/queues?topic=${encodeURIComponent(topic)}`, "queues.read");
  const canReplay = hasPrivilege(staff, "queues.replay");
  const counts = await Promise.all(topics.map(async (t) => [t.topic, await safe(`queue.deadLetters ${t.topic}`, () => listDeadLetters(t.topic, 200))] as const));
  const dead = new Map(counts);
  const letters = dead.get(topic);

  return (
    <>
      <PageHeader title="Queues" description="Background jobs that could not be processed after all retries. Payloads are shown with email addresses and phone numbers masked." />
      <LinkTabs label="View" items={[{ href: "/queues", label: "Dead letters", active: true }, { href: "/queues/email", label: "Email delivery log", active: false }]} />
      <LinkTabs
        label="Queue topic"
        variant="underline"
        items={topics.map((t) => ({
          href: `/queues?topic=${encodeURIComponent(t.topic)}`,
          label: `${t.topic} (${dead.get(t.topic)?.length ?? "?"})`,
          active: t.topic === topic,
        }))}
      />
      <p className="text-sm text-muted">{topics.find((t) => t.topic === topic)?.description}</p>
      {!canReplay ? <Alert tone="info">You can inspect dead letters but your role cannot replay them.</Alert> : null}
      {letters === null || letters === undefined ? (
        <Alert tone="warning">The queue is currently unavailable.</Alert>
      ) : letters.length === 0 ? (
        <EmptyState title="No dead letters" description="Every job on this topic has been processed." />
      ) : (
        <Table>
          <thead><tr><Th>Job</Th><Th>Attempts</Th><Th>Enqueued</Th><Th>Payload</Th>{canReplay ? <Th /> : null}</tr></thead>
          <tbody>
            {letters.map((m) => (
              <tr key={m.id}>
                <Td><Mono>{m.id}</Mono></Td>
                <Td className="whitespace-nowrap">{m.attempt} / {m.maxAttempts}</Td>
                <Td className="whitespace-nowrap">{fmtDate(m.enqueuedAt)}</Td>
                <Td className="max-w-md">
                  <details>
                    <summary className="cursor-pointer text-brand-700">View payload</summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-canvas p-2 text-xs">{json(m.payload)}</pre>
                  </details>
                </Td>
                {canReplay ? <Td className="text-right"><ReplayButton topic={topic} id={m.id} /></Td> : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
