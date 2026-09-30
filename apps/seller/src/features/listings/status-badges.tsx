import { useTranslations } from "next-intl";
import { Badge } from "@cnote/ui";
import type { ListingView } from "@cnote/catalogue";

export function ListingStatusBadges({ listing, summary }: { listing: ListingView; summary?: string }) {
  const t = useTranslations("listings.status");
  const status = { draft: "neutral", published: "success", archived: "neutral" } as const;
  const mod = { pending: "neutral", approved: "success", review: "warning", rejected: "danger" } as const;
  const st = status[listing.status];
  const mt = mod[listing.moderationStatus];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={st}>{t(listing.status)}</Badge>
      <Badge tone={mt}>{t(`moderation.${listing.moderationStatus}`)}</Badge>
      {summary ? <span className="text-xs text-muted" data-testid="version-summary">{summary}</span> : null}
      {listing.aiGenerated ? <Badge tone="brand">{t("aiDraft")}</Badge> : null}
    </div>
  );
}
