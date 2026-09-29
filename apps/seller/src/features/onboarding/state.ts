import "server-only";
import type { ListingView } from "@cnote/catalogue";
import type { Session } from "@cnote/identity";
import { ONB, readOnb } from "@/lib/cookies";
import { load } from "@/lib/safe";
import { catalogue, identity } from "@/lib/services";

export const STEPS = [
  { n: 1, title: "Your business" },
  { n: 2, title: "Verify phone" },
  { n: 3, title: "GST" },
  { n: 4, title: "First listing" },
  { n: 5, title: "Plan and consents" },
] as const;

export type OnboardingState =
  | { step: 1 | 2 | 3 | 5 }
  | { step: 4; draft: ListingView | null; loadError?: string }
  | { step: "done" };

/**
 * Where a seller should resume. Derived from server state (business, phone, tier, listings, consent),
 * plus two "skipped" cookies and a "finished" cookie, so closing the tab loses nothing.
 */
export async function getOnboardingState(session: Session): Promise<OnboardingState> {
  const b = session.business;
  if (!b || !b.isSeller) return { step: 1 };
  if (!session.phoneVerified) return { step: 2 };
  if ((await readOnb(ONB.done)) === "1") return { step: "done" };
  if (b.verificationTier < 1 && (await readOnb(ONB.skipGst)) !== "1") return { step: 3 };

  const listings = await load(() => catalogue.listSellerListings(b.id));
  if (!listings.ok) return { step: 4, draft: null, loadError: listings.error };
  const untouched = (l: ListingView) => l.status === "draft" && l.moderationStatus === "pending";
  const hasListing = listings.data.some((l) => !untouched(l));
  if (!hasListing && (await readOnb(ONB.skipListing)) !== "1") {
    return { step: 4, draft: listings.data.find(untouched) ?? null };
  }

  const consents = await load(() => identity.getConsents(session.personId));
  if (consents.ok && consents.data.matching) return { step: "done" };
  return { step: 5 };
}
