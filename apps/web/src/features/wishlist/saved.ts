import "server-only";
import { currentSession } from "@cnote/next-kit";
import { countSaved, listSavedListingIds } from "@cnote/wishlist";
import { cache } from "react";

/** Per-request saved state for product cards: one query for the whole page. Fails soft (guest view). */
export const loadSavedState = cache(async (): Promise<{ signedIn: boolean; saved: ReadonlySet<string> }> => {
  try {
    const s = await currentSession();
    if (!s) return { signedIn: false, saved: new Set() };
    return { signedIn: true, saved: new Set(await listSavedListingIds(s.personId)) };
  } catch (err) {
    console.error("[web] wishlist.loadSavedState failed:", err instanceof Error ? err.message : err);
    return { signedIn: false, saved: new Set() };
  }
});

export async function loadSavedCount(personId: string): Promise<number> {
  try {
    return await countSaved(personId);
  } catch {
    return 0;
  }
}
