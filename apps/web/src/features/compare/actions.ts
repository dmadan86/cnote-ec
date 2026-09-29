"use server";
import { getPublicListingsByIds } from "@cnote/catalogue";
import type { CompareToggleResult } from "@cnote/ui";
import { addToCompare, COMPARE_COOKIE, COMPARE_COOKIE_MAX_AGE, COMPARE_MAX, parseCompareIds, serializeCompareIds } from "@cnote/wishlist";
import { cookies } from "next/headers";
import { isPublicListing } from "./state";

async function writeTray(ids: string[]) {
  const jar = await cookies();
  if (!ids.length) jar.delete(COMPARE_COOKIE);
  else jar.set(COMPARE_COOKIE, serializeCompareIds(ids), { path: "/", maxAge: COMPARE_COOKIE_MAX_AGE, sameSite: "lax", httpOnly: false, secure: process.env.NODE_ENV === "production" });
}

async function readTray() {
  return parseCompareIds((await cookies()).get(COMPARE_COOKIE)?.value);
}

/** Adds to / removes from the compare tray. `replace` clears the tray first (category switch). */
export async function toggleCompareAction(listingId: string, opts?: { replace?: boolean }): Promise<CompareToggleResult> {
  const id = parseCompareIds(listingId)[0];
  if (!id) return { status: "error", message: "This product can't be compared." };
  const tray = await readTray();
  if (tray.includes(id)) {
    await writeTray(tray.filter((x) => x !== id));
    return { status: "removed" };
  }
  const [listing, ...trayListings] = (await getPublicListingsByIds([id, ...tray])).filter(isPublicListing);
  if (!listing || listing.id !== id) return { status: "error", message: "This product is no longer available." };
  const base = opts?.replace ? [] : tray;
  const res = addToCompare(base, id, listing.category.id, trayListings[0]?.category.id ?? null);
  if (res.status === "category_mismatch") {
    return {
      status: "category_mismatch",
      message: `Your compare tray has ${trayListings[0]?.category.name ?? "products"} from another category. Specifications differ between categories, so side-by-side comparison only works within one category.`,
    };
  }
  if (res.status === "full") return { status: "full", message: `You can compare up to ${COMPARE_MAX} products. Remove one first.` };
  await writeTray(res.ids);
  return { status: "added" };
}

/** Form actions for the tray (work without client JS). */
export async function removeFromCompareAction(f: FormData): Promise<void> {
  const id = parseCompareIds(String(f.get("listingId") ?? ""))[0];
  if (!id) return;
  await writeTray((await readTray()).filter((x) => x !== id));
}

export async function clearCompareAction(): Promise<void> {
  await writeTray([]);
}
