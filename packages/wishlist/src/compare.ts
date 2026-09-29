// Compare tray helpers (pure; the tray itself lives in a cookie, so this module has no tables).

export const COMPARE_COOKIE = "cnote_compare";
export const COMPARE_MAX = 4;
export const COMPARE_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses a comma-separated id list (cookie value or `?ids=`): valid uuids only, deduped, first COMPARE_MAX kept. */
export function parseCompareIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    /* use raw */
  }
  const out: string[] = [];
  for (const part of text.split(",")) {
    const id = part.trim().toLowerCase();
    if (UUID.test(id) && !out.includes(id)) out.push(id);
    if (out.length === COMPARE_MAX) break;
  }
  return out;
}

export function serializeCompareIds(ids: readonly string[]): string {
  return parseCompareIds(ids.join(",")).join(",");
}

export type CompareAddResult =
  | { status: "added" | "already"; ids: string[] }
  | { status: "full"; ids: string[] }
  | { status: "category_mismatch"; ids: string[] };

/**
 * Decides whether `id` (in `categoryId`) can join the tray. `trayCategoryId` is the category of the
 * products already in it (null when empty). Products must share a category because attribute sets differ.
 */
export function addToCompare(ids: readonly string[], id: string, categoryId: string, trayCategoryId: string | null): CompareAddResult {
  const current = parseCompareIds(ids.join(","));
  const norm = id.toLowerCase();
  if (current.includes(norm)) return { status: "already", ids: current };
  if (current.length > 0 && trayCategoryId !== null && trayCategoryId !== categoryId) return { status: "category_mismatch", ids: current };
  if (current.length >= COMPARE_MAX) return { status: "full", ids: current };
  return { status: "added", ids: [...current, norm] };
}
