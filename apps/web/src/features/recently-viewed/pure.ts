// Pure helpers for the recently-viewed list (unit-tested in test/recently-viewed.test.ts; no window/storage access).

export interface RecentEntry {
  id: string;
  /** unix ms of the last view */
  at: number;
}

export const RECENT_MAX = 12;
/** Storage limitation (DPDP s.8(7)): entries older than this are dropped on read. */
export const RECENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tolerant parse: anything malformed, expired or duplicated is dropped; never throws. */
export function parseRecent(raw: string | null, now: number): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = (data as { v?: number; items?: unknown })?.v === 1 ? (data as { items?: unknown }).items : null;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: RecentEntry[] = [];
  for (const e of list) {
    const id = typeof e?.id === "string" ? e.id.toLowerCase() : "";
    const at = typeof e?.at === "number" && Number.isFinite(e.at) ? e.at : 0;
    if (!UUID.test(id) || seen.has(id) || now - at > RECENT_MAX_AGE_MS || at > now + 60_000) continue;
    seen.add(id);
    out.push({ id, at });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, RECENT_MAX);
}

export const serializeRecent = (entries: readonly RecentEntry[]): string => JSON.stringify({ v: 1, items: entries.slice(0, RECENT_MAX) });

/** Puts `id` first, removing an earlier occurrence, capped at RECENT_MAX. Ignores non-UUIDs. */
export function pushRecent(entries: readonly RecentEntry[], id: string, now: number): RecentEntry[] {
  const norm = id.toLowerCase();
  if (!UUID.test(norm)) return [...entries];
  return [{ id: norm, at: now }, ...entries.filter((e) => e.id !== norm)].slice(0, RECENT_MAX);
}
