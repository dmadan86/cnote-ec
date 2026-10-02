import { buttonClasses } from "@cnote/ui";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * "Request again": opens the requirement form prefilled from an earlier enquiry or order (same spec, quantity, delivery), with the
 * same supplier offered first. It only links to the form: nothing is created until the buyer reviews and sends it.
 */
export async function RequestAgain({ enquiryId, orderId, locale }: { enquiryId?: string | null; orderId?: string; locale: string }) {
  const t = await getTranslations({ locale, namespace: "retention" });
  const qs = new URLSearchParams();
  if (enquiryId) qs.set("again", enquiryId);
  if (orderId) qs.set("order", orderId);
  if (!qs.size) return null;
  return (
    <Link href={`/rfq/new?${qs}`} className={buttonClasses("accent", "md", "min-h-11")} aria-describedby="request-again-hint" data-testid="request-again">
      <RotateCcw className="size-4" aria-hidden /> {t("again.action")}
      <span id="request-again-hint" className="sr-only">{t("again.hint")}</span>
    </Link>
  );
}

/** Which enquiries offer it: finished or quoted requirements (a live, unanswered one is still running). */
export function canRequestAgain(e: { status: string; quoteCount?: number; expiresAt: string | null }, now = Date.now()): boolean {
  return e.status === "closed" || (e.quoteCount ?? 0) > 0 || (e.expiresAt !== null && Date.parse(e.expiresAt) < now);
}
