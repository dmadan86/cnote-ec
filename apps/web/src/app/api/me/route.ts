import { NextResponse } from "next/server";
import { currentSession } from "@cnote/next-kit";
import { getPublicListingsByIds } from "@cnote/catalogue";
import { readCompareIds } from "@/features/compare/state";
import { listSavedListingIds } from "@cnote/wishlist";

/**
 * Per-user state for the static shells: session summary, saved listing ids, compare tray. Always private and
 * uncacheable (Cache-Control + Vary: Cookie) so a CDN can never serve one user's state to another.
 */
export async function GET() {
  const started = performance.now();
  const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
  let session = null;
  try {
    session = await currentSession();
  } catch {
    /* treat any failure as signed out */
  }
  const compareIds = await readCompareIds();
  const [savedIds, compare] = await Promise.all([
    session ? listSavedListingIds(session.personId).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    compareIds.length ? getPublicListingsByIds(compareIds).catch(() => []) : Promise.resolve([]),
  ]);
  const body = {
    signedIn: !!session,
    name: session?.name ?? null,
    email: session?.email ?? null,
    isSeller: !!session?.business?.isSeller,
    savedIds,
    savedCount: savedIds.length,
    compareIds: compare.map((l) => l.id),
    compareItems: compare.map((l) => ({ id: l.id, title: l.title, image: l.imageUrls[0] ?? null })),
  };
  return NextResponse.json(body, { headers: { ...headers, "Server-Timing": `me;dur=${(performance.now() - started).toFixed(1)}` } });
}
