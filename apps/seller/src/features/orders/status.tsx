import { Badge, type BadgeTone } from "@cnote/ui";
import type { OrderView } from "@cnote/enquiry";

const STATUS: Record<OrderView["status"], { label: string; tone: BadgeTone }> = {
  recorded: { label: "Awaiting confirmation", tone: "warning" },
  confirmed: { label: "Confirmed", tone: "brand" },
  dispatched: { label: "Dispatched", tone: "brand" },
  delivered: { label: "Delivered", tone: "success" },
  completed: { label: "Completed", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function OrderStatusBadge({ status }: { status: OrderView["status"] }) {
  const s = STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
