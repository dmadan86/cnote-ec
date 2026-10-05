import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Locale } from "./config";

type Json = { [k: string]: Json | string };
export type Messages = Json;

function merge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith("_")) continue; // _todo / _meta markers are not messages
    const b = out[k];
    out[k] = typeof v === "object" && v !== null && typeof b === "object" && b !== null ? merge(b, v) : v;
  }
  return out;
}

/**
 * Catalogues live in apps/seller/messages as `<locale>.json` (common + shell) and `<locale>.<namespace>.json` (one per
 * feature area, owned by that feature). A namespace file's content sits under its namespace key. The bundler needs a
 * static import pattern, so names come from this list plus a best-effort directory scan on the server.
 */
export const KNOWN_NAMESPACES = [
  "landing", "auth", "onboarding", "dashboard", "listings", "leads", "orders", "billing", "verification", "settings", "reviews", "questions",
  "notifications", "storefront", "appeals", "disputes", "offers", "referrals", "ads", "ondc", "negotiation", "escrow", "quality",
  "credit", "a2a", "prices", "authForms", "errors", "mfa", "states", "rfqLead", "billingAnnual", "consent",
  "stock", // variants-stock: availability, stock toggle, variant matrix
];

function discoverNamespaces(): string[] {
  const found = new Set(KNOWN_NAMESPACES);
  try {
    for (const dir of [join(process.cwd(), "messages"), join(process.cwd(), "apps", "seller", "messages")]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const m = /^en\.([A-Za-z0-9_-]+)\.json$/.exec(f);
        if (m) found.add(m[1]!);
      }
      break;
    }
  } catch {
    /* no fs: the known list is used */
  }
  return [...found].sort();
}

async function loadFile(locale: string, ns: string | null): Promise<Json | null> {
  try {
    const mod = (ns ? await import(`../../messages/${locale}.${ns}.json`) : await import(`../../messages/${locale}.json`)) as { default: Json };
    return ns && !(ns in mod.default) ? { [ns]: mod.default } : mod.default;
  } catch {
    return null; // not translated yet for this locale: English is used per key
  }
}

async function loadLocaleFiles(locale: string): Promise<Json> {
  let out: Json = (await loadFile(locale, null)) ?? {};
  for (const ns of discoverNamespaces()) {
    const part = await loadFile(locale, ns);
    if (part) out = merge(out, part);
  }
  return out;
}

const cache = new Map<string, Promise<Messages>>();

/** Catalogue for a locale, deep-merged per key over English so a missing translation never renders as a raw key. */
export function loadMessages(locale: Locale): Promise<Messages> {
  let hit = cache.get(locale);
  if (!hit) {
    hit = (async () => {
      const english = await loadLocaleFiles("en");
      return locale === "en" ? english : merge(english, await loadLocaleFiles(locale));
    })();
    cache.set(locale, hit);
  }
  return hit;
}
