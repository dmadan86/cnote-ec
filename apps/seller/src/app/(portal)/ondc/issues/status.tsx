import { useTranslations } from "next-intl";
import { Badge, type BadgeTone } from "@cnote/ui";

const TONE: Record<string, BadgeTone> = { open: "warning", processing: "brand", resolved: "success", closed: "neutral" };
const KNOWN_CATEGORIES = ["ITEM", "FULFILLMENT", "ORDER", "PAYMENT"];

export function IssueStatusBadge({ status }: { status: string }) {
  const t = useTranslations("ondc.issues.status");
  return <Badge tone={TONE[status] ?? "neutral"}>{TONE[status] ? t(status as "open") : status}</Badge>;
}

export function IssueCategory({ category }: { category: string }) {
  const t = useTranslations("ondc.issues.category");
  const c = category.toUpperCase();
  return <>{KNOWN_CATEGORIES.includes(c) ? t(c as "ITEM") : t("other")}</>;
}
