import type { BulkJobView } from "@cnote/bulk";
import { Badge, type BadgeTone } from "@cnote/ui";

export const STATUS: Record<BulkJobView["status"], { tone: BadgeTone; label: string }> = {
  uploaded: { tone: "neutral", label: "Uploaded" },
  validating: { tone: "brand", label: "Checking your file" },
  validated: { tone: "accent", label: "Ready to confirm" },
  queued: { tone: "brand", label: "Waiting to start" },
  processing: { tone: "brand", label: "Importing" },
  completed: { tone: "success", label: "Completed" },
  completed_with_errors: { tone: "warning", label: "Completed with errors" },
  failed: { tone: "danger", label: "Failed" },
  cancelled: { tone: "neutral", label: "Cancelled" },
  expired: { tone: "neutral", label: "Files deleted" },
};

export function JobBadge({ status }: { status: BulkJobView["status"] }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const fmtDate = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
