import { Badge, type BadgeTone } from "@cnote/ui";
import type { EnquiryView, MatchView } from "@cnote/enquiry";

const ENQUIRY: Record<EnquiryView["status"], { label: string; tone: BadgeTone }> = {
  scoring: { label: "Processing", tone: "neutral" },
  review: { label: "Held for review", tone: "warning" },
  matched: { label: "Matched", tone: "success" },
  unmatched: { label: "No sellers found yet", tone: "warning" },
  closed: { label: "Closed", tone: "neutral" },
  rejected: { label: "Not accepted", tone: "danger" },
};

const MATCH: Record<MatchView["status"], { label: string; tone: BadgeTone }> = {
  offered: { label: "Waiting for reply", tone: "brand" },
  accepted: { label: "Replied - in conversation", tone: "success" },
  declined: { label: "Declined", tone: "neutral" },
  expired: { label: "No reply in time", tone: "neutral" },
  refunded: { label: "Closed", tone: "neutral" },
};

export function enquiryStatusLabel(e: Pick<EnquiryView, "status" | "awaitingPick">) {
  return e.awaitingPick ? { label: "Pick your sellers", tone: "brand" as BadgeTone } : ENQUIRY[e.status];
}

export function EnquiryStatusBadge({ enquiry }: { enquiry: Pick<EnquiryView, "status" | "awaitingPick"> }) {
  const s = enquiryStatusLabel(enquiry);
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function MatchStatusBadge({ status }: { status: MatchView["status"] }) {
  const s = MATCH[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}
