import { Badge } from "@cnote/ui";
import type { ListingView } from "@cnote/catalogue";

export function ListingStatusBadges({ listing, summary }: { listing: ListingView; summary?: string }) {
  const status = { draft: ["neutral", "Draft"], published: ["success", "Published"], archived: ["neutral", "Archived"] } as const;
  const mod = {
    pending: ["neutral", "Not checked yet"],
    approved: ["success", "Cleared"],
    review: ["warning", "In manual review"],
    rejected: ["danger", "Rejected"],
  } as const;
  const [st, stLabel] = status[listing.status];
  const [mt, mLabel] = mod[listing.moderationStatus];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={st}>{stLabel}</Badge>
      <Badge tone={mt}>{mLabel}</Badge>
      {summary ? <span className="text-xs text-muted" data-testid="version-summary">{summary}</span> : null}
      {listing.aiGenerated ? <Badge tone="brand">AI draft</Badge> : null}
    </div>
  );
}
