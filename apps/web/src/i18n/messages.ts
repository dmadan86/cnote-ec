import type { CatalogueLocale } from "./config";
import en from "../../messages/en.json";

export type Messages = typeof en;
type Json = { [k: string]: Json | string };

function merge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith("_")) continue; // _todo / _meta markers are not messages
    const b = out[k];
    out[k] = typeof v === "object" && v !== null && typeof b === "object" && b !== null ? merge(b, v) : v;
  }
  return out;
}

/** Catalogue for a locale, deep-merged over English so a missing key never renders as a raw key. */
export async function loadMessages(locale: CatalogueLocale): Promise<Messages> {
  if (locale === "en") return en;
  const mod = (await import(`../../messages/${locale}.json`)) as { default: Json };
  return merge(en as unknown as Json, mod.default) as unknown as Messages;
}

/** Namespaces client components read (everything else stays server-side and out of the client payload). */
export const CLIENT_NAMESPACES = ["shell", "search", "rails", "consent", "unlock", "leadgen", "ui", "lang", "errors", "cards", "auth", "rfq"] as const;

export function pickClientMessages(all: Messages): Partial<Messages> {
  const out: Record<string, unknown> = {};
  for (const ns of CLIENT_NAMESPACES) if (ns in all) out[ns] = (all as Record<string, unknown>)[ns];
  return out as Partial<Messages>;
}
