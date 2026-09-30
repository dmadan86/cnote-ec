import { Badge, type BadgeTone } from "@cnote/ui";
import type { OrderView } from "@cnote/enquiry";
import { useTranslations } from "next-intl";

const TONE: Record<OrderView["status"], BadgeTone> = {
  recorded: "warning",
  confirmed: "brand",
  dispatched: "brand",
  delivered: "success",
  completed: "success",
  cancelled: "neutral",
};

export function OrderStatusBadge({ status }: { status: OrderView["status"] }) {
  const t = useTranslations("buyer");
  return <Badge tone={TONE[status]}>{t(`orderStatus.${status}`)}</Badge>;
}
