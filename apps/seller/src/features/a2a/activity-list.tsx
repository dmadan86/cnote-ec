import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@cnote/ui";
import type { ActivityView } from "@cnote/a2a";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";

/** "What your agent did": newest first, marked as done by the agent alone or by you. Summaries come from the audit log. */
export function ActivityList({ items }: { items: ActivityView[] }) {
  const t = useTranslations("a2a");
  const loc = useLocale();
  const locale = isLocale(loc) ? loc : "en";
  if (items.length === 0) return <p className="text-sm text-muted">{t("activity.empty")}</p>;
  return (
    <ol className="space-y-2" aria-label={t("activity.label")}>
      {items.map((a) => (
        <li key={a.id} className="rounded-lg border border-line p-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={a.byAgent ? "neutral" : "success"}>{a.byAgent ? t("activity.agent") : t("activity.you")}</Badge>
            <span className="text-xs text-muted">{formatDateTime(a.createdAt, locale)}</span>
          </p>
          <p className="mt-1 text-ink">{a.summary}</p>
          {a.negotiationId ? <Link href={`/agents/negotiations/${a.negotiationId}`} className="mt-1 inline-block text-xs font-semibold text-brand-700 underline">{t("activity.open")}</Link> : null}
        </li>
      ))}
    </ol>
  );
}
