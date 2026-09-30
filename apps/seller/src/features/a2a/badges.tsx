import { useTranslations } from "next-intl";
import { Badge, type BadgeTone } from "@cnote/ui";

const MANDATE_TONE: Record<string, BadgeTone> = { active: "success", paused: "warning", revoked: "neutral", expired: "neutral", completed: "neutral", suspended: "danger" };
const NEG_TONE: Record<string, BadgeTone> = { open: "brand", agreed: "warning", accepted: "success", rejected: "neutral", withdrawn: "neutral", expired: "neutral" };

export function MandateStatusBadge({ status }: { status: string }) {
  const t = useTranslations("a2a");
  return <Badge tone={MANDATE_TONE[status] ?? "neutral"}>{t(`mandateStatus.${status}`)}</Badge>;
}
export function NegotiationStatusBadge({ status }: { status: string }) {
  const t = useTranslations("a2a");
  return <Badge tone={NEG_TONE[status] ?? "neutral"}>{t(`negotiationStatus.${status}`)}</Badge>;
}
