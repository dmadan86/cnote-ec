"use server";
// Wishlist server actions. Each re-checks the session: server actions are reachable by direct POST.
import { addItem, createList, deleteList, isSaved, moveItem, removeFromAll, removeItem, renameList, updateNote } from "@cnote/wishlist";
import { currentSession, requireSession, type ActionResult } from "@cnote/next-kit";
import { getTranslations } from "next-intl/server";
import { runLocalized } from "@/i18n/errors";
import { getRequestLocale } from "@/lib/request-locale";
import type { WishlistToggleResult } from "@cnote/ui";
import { DomainError } from "@cnote/core";
import { revalidatePath } from "next/cache";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};
const refresh = () => revalidatePath("/wishlist");

/** Heart toggle on cards and the product page: saves to the default list, or removes from every list. */
export async function toggleSavedAction(listingId: string): Promise<WishlistToggleResult> {
  const s = await currentSession();
  if (!s) return { ok: false, error: (await getTranslations({ locale: await getRequestLocale(), namespace: "wishlist" }))("signInPrompt") };
  try {
    const already = (await isSaved(s.personId, [listingId])).has(listingId);
    if (already) await removeFromAll(s.personId, listingId);
    else await addItem(s.personId, listingId);
    refresh();
    return { ok: true, saved: !already };
  } catch (err) {
    if (err instanceof DomainError) return { ok: false, error: err.message };
    throw err;
  }
}

export async function createListAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    await createList(s.personId, str(f, "name"));
    refresh();
  });
}

export async function renameListAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    await renameList(s.personId, str(f, "listId"), str(f, "name"));
    refresh();
  });
}

export async function deleteListAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    await deleteList(s.personId, str(f, "listId"));
    refresh();
  });
}

export async function removeItemAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    await removeItem(s.personId, str(f, "listId"), str(f, "listingId"));
    refresh();
  });
}

export async function moveItemAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    await moveItem(s.personId, {
      fromListId: str(f, "listId"),
      toListId: str(f, "toListId"),
      listingId: str(f, "listingId"),
      copy: str(f, "mode") === "copy",
    });
    refresh();
  });
}

export async function updateNoteAction(_prev: ActionResult | null, f: FormData): Promise<ActionResult> {
  const s = await requireSession("/wishlist");
  return runLocalized(async () => {
    await updateNote(s.personId, str(f, "listId"), str(f, "listingId"), str(f, "note") || null);
    refresh();
  });
}
