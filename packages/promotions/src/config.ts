// Tunables. Env-overridable where an operator may reasonably want to change them without a deploy of code.
const int = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};

/** Kill switch (design section 10): PROMOTIONS_ENABLED=false hides all promotions and offers from readers and blocks new offers. */
export const promotionsEnabled = () => !["false", "0", "off"].includes((process.env.PROMOTIONS_ENABLED ?? "true").toLowerCase());

export const OFFER = {
  maxTiers: 5,
  /** timed price: at most this many days */
  maxTimedDays: 30,
  /** timed price: days that must pass after one ends before another can start on the same listing */
  cooldownDays: 14,
  /** below this discount (vs the honest reference) a timed offer is rejected as pointless; above MAX it is held for review */
  minDiscountBps: 300,
  maxDiscountBps: 5000,
  /** absolute floor (paise) below which an offer is always held for review; PROMOTIONS_OFFER_FLOORS can raise it per category */
  floorPaise: 100,
  /** upheld honour reports in the window that suspend a seller's offer privileges */
  suspendAfterUpheld: 3,
  upheldWindowDays: 90,
  /** how far ahead an offer may be scheduled */
  maxLeadDays: 30,
  /** max cache age for a public offer read */
  cacheSeconds: 60,
} as const;

/** Optional per-category floors: PROMOTIONS_OFFER_FLOORS='{"kraft-boxes":500}' (paise). */
export function offerFloorPaise(categorySlug: string | null | undefined): number {
  try {
    const m = JSON.parse(process.env.PROMOTIONS_OFFER_FLOORS ?? "{}") as Record<string, number>;
    const v = categorySlug ? m[categorySlug] : undefined;
    return Math.max(OFFER.floorPaise, typeof v === "number" && Number.isFinite(v) ? v : 0);
  } catch {
    return OFFER.floorPaise;
  }
}

export const COUPON = {
  /** code attempts per business per hour */
  attemptsPerHour: int("PROMOTIONS_COUPON_ATTEMPTS_PER_HOUR", 15),
  /** coupons above this need a second approver (design 6.3) */
  largePercentBps: 5000,
  largeFlatPaise: 500_000,
  largeExtraCredits: 200,
  quoteSnapshotSeconds: 3600,
} as const;

export const REFERRAL = {
  holdDays: 7,
  rewardCredits: int("PROMOTIONS_REFERRAL_REWARD_CREDITS", 10),
  /** rewarded or held referrals per referrer per calendar quarter */
  quarterlyCap: int("PROMOTIONS_REFERRAL_QUARTERLY_CAP", 10),
} as const;

export const DAY_MS = 86_400_000;
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);
