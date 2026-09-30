import { useLocale, useTranslations } from "next-intl";
import type { BulkJobView } from "@cnote/bulk";
import { Badge, type BadgeTone } from "@cnote/ui";
import { intlTag } from "@/i18n/config";

export const STATUS: Record<BulkJobView["status"], { tone: BadgeTone }> = {
  uploaded: { tone: "neutral" },
  validating: { tone: "brand" },
  validated: { tone: "accent" },
  queued: { tone: "brand" },
  processing: { tone: "brand" },
  completed: { tone: "success" },
  completed_with_errors: { tone: "warning" },
  failed: { tone: "danger" },
  cancelled: { tone: "neutral" },
  expired: { tone: "neutral" },
};

export function JobBadge({ status }: { status: BulkJobView["status"] }) {
  const t = useTranslations("listings.bulk.status");
  return <Badge tone={STATUS[status].tone}>{t(status)}</Badge>;
}

/** Date + time in the seller's language, e.g. `hi-IN`. */
export function useFmtDate(): (iso: string) => string {
  const locale = useLocale();
  return (iso) => new Date(iso).toLocaleString(intlTag(locale), { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
}
