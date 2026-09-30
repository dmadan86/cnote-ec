import "server-only";
// Server-side label loader for the disputes namespace (apps/web/messages/<locale>.disputes.json, all 8 locales, identical keys).
// Client components receive the plain-string map as a prop so the namespace never ships in the client bundle.
import { getTranslations } from "next-intl/server";
import en from "../../../messages/en.disputes.json";
import type { DisputeLabels } from "./types";
import type { Locale } from "@/i18n/config";


export async function disputeLabels(locale: Locale = "en"): Promise<DisputeLabels> {
  const t = await getTranslations({ locale, namespace: "disputes" });
  return Object.fromEntries(Object.keys(en.disputes).map((k) => [k, t.raw(k) as string])) as DisputeLabels;
}

export const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
