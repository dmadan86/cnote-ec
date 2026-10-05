import "server-only";
// Server-side label loader for the samples namespace (apps/web/messages/<locale>.samples.json, all 8 locales, identical keys).
// Client components receive the plain-string map as a prop so the namespace never ships in the client bundle.
import { getTranslations } from "next-intl/server";
import en from "../../../messages/en.samples.json";
import type { Locale } from "@/i18n/config";

export type SampleLabels = Record<keyof typeof en.samples, string>;

export async function sampleLabels(locale: Locale | string = "en"): Promise<SampleLabels> {
  const t = await getTranslations({ locale, namespace: "samples" });
  return Object.fromEntries(Object.keys(en.samples).map((k) => [k, t.raw(k) as string])) as SampleLabels;
}

/** "Hello {name}" -> values filled in (labels are raw ICU-free strings with simple {name} placeholders). */
export const fill = (s: string, vars: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
