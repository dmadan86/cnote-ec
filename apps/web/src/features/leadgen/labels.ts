"use client";
import { DEFAULT_UNLOCK_LABELS, type UnlockLabels } from "@cnote/next-kit/client";
import type { Unlock } from "@cnote/leadgen";
import { useTranslations } from "next-intl";

/** Raw (placeholder-preserving) translated strings for the unlock dialog; the dialog fills {phone}/{channel}/{n}/{code}. */
export function useUnlockLabels(): UnlockLabels {
  const t = useTranslations("unlock");
  return Object.fromEntries(Object.keys(DEFAULT_UNLOCK_LABELS).map((k) => [k, t.raw(k) as string])) as unknown as UnlockLabels;
}

/** Dialog heading per unlock type, e.g. "Get the best price for <title>". */
export function useUnlockHeadings(): Record<Unlock, (title: string) => string> {
  const t = useTranslations("leadgen");
  return {
    enquiry: (title) => t("headingEnquiry", { title }),
    seller_contact: (title) => t("headingSeller", { title }),
    quotes: (title) => t("headingQuotes", { title }),
    save: () => t("headingSave"),
    catalogue: () => t("headingCatalogue"),
  };
}
