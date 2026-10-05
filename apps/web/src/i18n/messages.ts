import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { CatalogueLocale } from "./config";
import en from "../../messages/en.json";

export type Messages = typeof en;
type Json = { [k: string]: Json | Json[] | string | string[] };

function merge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith("_")) continue; // _todo / _meta markers are not messages
    const b = out[k];
    // Arrays (e.g. legal page sections) are replaced as a whole: spreading one into an object would break its shape.
    out[k] = typeof v === "object" && v !== null && !Array.isArray(v) && typeof b === "object" && b !== null && !Array.isArray(b) ? merge(b, v) : v;
  }
  return out;
}

/**
 * Namespaced catalogue files that sit next to `<locale>.json` as `<locale>.<namespace>.json` (e.g. en.ads.json).
 * The bundler needs static import patterns, so files are found through the template import below; this list plus a
 * best-effort directory scan (server only, `messages/` next to the app) decides which names to try. A file whose top
 * level already has a `<namespace>` key is merged as-is; otherwise its content is placed under that namespace.
 */
const KNOWN_NAMESPACE_FILES = ["a2a", "account", "account2", "actions", "ads", "buyer", "compare", "credit", "disputes", "escrow", "help", "negotiation", "prices", "promotions", "quality", "rail", "reachability", "search", "supplier", "errors", "filters", "states", "grievance", "legal", "notif", "orderTracking", "pdp", "titles", "wishlist", "rfq2", "pricing2", "convenience", "qa", "retention", "samples"];

function discoverNamespaces(): string[] {
  const found = new Set(KNOWN_NAMESPACE_FILES);
  try {
    for (const dir of [join(process.cwd(), "messages"), join(process.cwd(), "apps", "web", "messages")]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        const m = /^en\.([A-Za-z0-9_-]+)\.json$/.exec(f);
        if (m) found.add(m[1]!);
      }
      break;
    }
  } catch {
    /* no fs (edge/browser bundle): the known list is used */
  }
  return [...found].sort();
}

async function loadFile(locale: string, ns: string | null): Promise<Json | null> {
  try {
    const mod = (ns ? await import(`../../messages/${locale}.${ns}.json`) : await import(`../../messages/${locale}.json`)) as { default: Json };
    const data = mod.default;
    return ns && !(ns in data) ? { [ns]: data } : data;
  } catch {
    return null; // file does not exist for this locale
  }
}

/** Every `<locale>.json` + `<locale>.<ns>.json` merged in a fixed order (base first, then namespaces alphabetically). */
async function loadLocaleFiles(locale: string): Promise<Json> {
  let out: Json = {};
  const base = await loadFile(locale, null);
  if (base) out = merge(out, base);
  for (const ns of discoverNamespaces()) {
    const part = await loadFile(locale, ns);
    if (part) out = merge(out, part);
  }
  return out;
}

const cache = new Map<string, Promise<Messages>>();

/** Catalogue for a locale, deep-merged per key over English so a missing key never renders as a raw key. */
export function loadMessages(locale: CatalogueLocale): Promise<Messages> {
  let hit = cache.get(locale);
  if (!hit) {
    hit = (async () => {
      const english = await loadLocaleFiles("en");
      return (locale === "en" ? english : merge(english, await loadLocaleFiles(locale))) as unknown as Messages;
    })();
    cache.set(locale, hit);
  }
  return hit;
}

/** Raw merged files of one locale, no English fallback (used by the parity tests). */
export const loadLocaleCatalogue = loadLocaleFiles;

/** Namespaces client components read (everything else stays server-side and out of the client payload). */
export const CLIENT_NAMESPACES = ["shell", "search", "rails", "consent", "unlock", "leadgen", "ui", "lang", "errors", "filters", "states", "cards", "auth", "rfq", "rfq2", "compare", "rail", "pdp", "convenience", "qa", "deliverPick", "retention"] as const;

/**
 * Extra namespaces for client components of the dynamic routes (account, buyer, rfq, ...). Kept out of CLIENT_NAMESPACES
 * so the static public pages do not ship them; the (app) layout passes both lists.
 */
export const APP_CLIENT_NAMESPACES = ["account", "account2", "buyer", "wishlist", "notif", "grievance"] as const;

export function pickClientMessages(all: Messages, extra: readonly string[] = []): Partial<Messages> {
  const out: Record<string, unknown> = {};
  for (const ns of [...CLIENT_NAMESPACES, ...extra]) if (ns in all) out[ns] = (all as Record<string, unknown>)[ns];
  return out as Partial<Messages>;
}
