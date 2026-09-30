import { Badge } from "@cnote/ui";
import type { AgentActionView } from "@cnote/negotiation";
import { formatDateTime } from "@/lib/format";

/** "What the assistant did": every agent action for this business, with who confirmed it. Server-rendered, no client JS. */
export function AssistantLog({ actions }: { actions: AgentActionView[] }) {
  if (actions.length === 0) return <p className="text-sm text-muted">The assistant has not done anything for you yet.</p>;
  return (
    <ol className="space-y-2" aria-label="What the assistant did">
      {actions.map((a) => (
        <li key={a.id} className="rounded-lg border border-line p-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={a.byAssistant ? "neutral" : "success"}>{a.byAssistant ? "Assistant" : "You confirmed"}</Badge>
            <span className="text-xs text-muted">{formatDateTime(a.createdAt)}</span>
          </p>
          <p className="mt-1 text-ink">{a.summary}</p>
        </li>
      ))}
    </ol>
  );
}
