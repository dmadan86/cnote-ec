"use client";
import { CompareToggle, WishlistButton, type CompareToggleResult, type WishlistToggleResult } from "@cnote/ui";
import { toggleCompareAction } from "@/features/compare/actions";
import { toggleSavedAction } from "@/features/wishlist/actions";
import { ensureFresh, markSaved, refreshUserState, useUserState } from "./store";

/**
 * Heart button for cards and the product page. The surrounding HTML is static; saved/signed-in state arrives
 * from the shared per-user store after hydration (guests are sent to sign in on click).
 */
export function SaveIsland({ id, title, className }: { id: string; title: string; className?: string }) {
  const u = useUserState();
  const onToggle = async (listingId: string): Promise<WishlistToggleResult> => {
    await ensureFresh();
    const r = await toggleSavedAction(listingId);
    if (r.ok) markSaved(listingId, r.saved);
    return r;
  };
  return <WishlistButton id={id} title={title} saved={u.savedIds.includes(id)} onToggle={u.signedIn ? onToggle : undefined} className={className} />;
}

export function CompareIsland({ id, title, variant }: { id: string; title: string; variant?: "chip" | "button" }) {
  const u = useUserState();
  const onToggle = async (listingId: string, opts?: { replace?: boolean }): Promise<CompareToggleResult> => {
    const r = await toggleCompareAction(listingId, opts);
    if (r.status === "added" || r.status === "removed") void refreshUserState();
    return r;
  };
  return <CompareToggle id={id} title={title} inTray={u.compareIds.includes(id)} onToggle={onToggle} variant={variant} />;
}
