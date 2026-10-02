import { type ModuleWorker } from "@cnote/core";
import { promotionsEnabled } from "./config";
import { expireCoupons, releaseExpiredReservations } from "./coupons";
import { processOffers, revalidateListingOffers } from "./offers";
import { qualifyOnVerification, qualifyReferral, releaseDueReferrals } from "./referrals";
import { purgeWeb, promoTags } from "./tags";

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;

/** Handlers are idempotent (at-least-once delivery): every function they call is a no-op on a repeat. */
export const worker: ModuleWorker = {
  name: "promotions",
  handlers: {
    // A new live version, or the listing left LIVE: offers are re-validated against the LIVE price/MOQ (ends with `listing_changed`).
    ListingVersionPublished: async (e) => void (promotionsEnabled() && (await revalidateListingOffers(e.payload.listingId))),
    ListingUnpublished: async (e) => void (await revalidateListingOffers(e.payload.listingId)),
    ListingArchived: async (e) => void (await revalidateListingOffers(e.payload.listingId)),
    ListingModerated: async (e) => void (e.payload.status !== "approved" && (await revalidateListingOffers(e.payload.listingId))),
    // Referral qualification (design 6.4): a referee's first published listing, or reaching tier 1 after publishing one.
    ListingPublished: async (e) => void (promotionsEnabled() && (await qualifyReferral(e.payload.sellerBusinessId, "listing_published"))),
    BusinessVerified: async (e) => void (promotionsEnabled() && e.payload.tier >= 1 && (await qualifyOnVerification(e.payload.businessId))),
    // Buyer-side qualifying action: a verified (tier >= 1) business created its first enquiry. (LeadAccepted carries no buyer id.)
    EnquiryCreated: async (e) => void (promotionsEnabled() && (await qualifyReferral(e.payload.buyerBusinessId, "first_verified_enquiry"))),
    // Durable backstop for the web tier: redo the purge if the in-process one failed.
    PromotionPublished: async (e) => purgeWeb([promoTags.all, ...e.payload.surfaces.map(promoTags.surface)].map((tag) => ({ tag, hard: true }))),
    PromotionArchived: async () => purgeWeb([{ tag: promoTags.all, hard: true }]),
    OfferActivated: async (e) => purgeWeb([{ tag: promoTags.offer(e.payload.listingId), hard: true }, { tag: promoTags.offers }]),
    OfferEnded: async (e) => purgeWeb([{ tag: promoTags.offer(e.payload.listingId), hard: true }, { tag: promoTags.offers }]),
  },
  jobs: [
    { name: "promotions.process-offers", everyMs: MIN_MS, run: async () => void (await processOffers()) },
    { name: "promotions.release-referrals", everyMs: HOUR_MS, run: async () => void (promotionsEnabled() && (await releaseDueReferrals())) },
    { name: "promotions.release-coupon-reservations", everyMs: 5 * MIN_MS, run: async () => void (await releaseExpiredReservations()) },
    { name: "promotions.expire-coupons", everyMs: HOUR_MS, run: async () => void (await expireCoupons()) },
  ],
};
