import { Badge, type BadgeTone } from "@cnote/ui";
import type { EnquiryView, MatchView } from "@cnote/enquiry";
import { useTranslations } from "next-intl";

// Labels come from the `buyer` catalogue (enquiryStatus.*, matchStatus.*); only the tone lives here.
const ENQUIRY_TONE: Record<EnquiryView["status"], BadgeTone> = {
  scoring: "neutral",
  review: "warning",
  matched: "success",
  unmatched: "warning",
  closed: "neutral",
  rejected: "danger",
  pending_approval: "warning",
};

const MATCH_TONE: Record<MatchView["status"], BadgeTone> = {
  offered: "brand",
  accepted: "success",
  declined: "neutral",
  expired: "neutral",
  refunded: "neutral",
};

export function EnquiryStatusBadge({ enquiry }: { enquiry: Pick<EnquiryView, "status" | "awaitingPick"> }) {
  const t = useTranslations("buyer");
  const ta = useTranslations("approvals");
  if (enquiry.status === "pending_approval") return <Badge tone="warning">{ta("badge.awaiting")}</Badge>;
  return enquiry.awaitingPick ? <Badge tone="brand">{t("enquiryStatus.pick")}</Badge> : <Badge tone={ENQUIRY_TONE[enquiry.status]}>{t(`enquiryStatus.${enquiry.status}`)}</Badge>;
}

export function MatchStatusBadge({ status }: { status: MatchView["status"] }) {
  const t = useTranslations("buyer");
  return <Badge tone={MATCH_TONE[status]}>{t(`matchStatus.${status}`)}</Badge>;
}
