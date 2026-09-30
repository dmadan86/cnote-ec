export const STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" | "brand" }> = {
  draft: { label: "Draft", tone: "neutral" },
  pending_review: { label: "In review", tone: "brand" },
  approved: { label: "Approved", tone: "success" },
  active: { label: "Running", tone: "success" },
  paused: { label: "Paused", tone: "neutral" },
  exhausted: { label: "Daily budget used", tone: "warning" },
  suspended: { label: "Suspended", tone: "danger" },
  rejected: { label: "Not approved", tone: "danger" },
  ended: { label: "Ended", tone: "neutral" },
};

/** Why an approved campaign is not serving right now, in plain words (design 5.3: the seller is always told why). */
export const HALT_TEXT: Record<string, string> = {
  wallet: "Your ad wallet is empty. Add funds and the campaign resumes on its own.",
  eligibility: "None of the products in this campaign qualify right now. See the reasons below.",
  budget: "Today's budget is used up. It resumes at midnight (IST).",
  suspended: "This campaign was suspended by our team.",
};

export const INELIGIBLE_TEXT: Record<string, string> = {
  seller_unknown: "We could not load your business profile.",
  tier_below_min: "Your business needs a higher verification tier to advertise.",
  trust_below_floor: "Your trust score is below the minimum for ads.",
  listing_unpublished: "The product is not published and approved.",
  no_approved_image: "The product needs an approved photo.",
  no_price: "The product needs a price.",
  category_prohibited: "This category cannot be advertised.",
  no_rate_card: "No price per click is set for this category yet.",
};

export const REVIEW_TEXT: Record<string, string> = { pending: "Waiting for review", approved: "Approved", rejected: "Not approved" };

export const SURFACE_LABEL: Record<string, string> = { search: "Search results", category: "Category pages", product_similar: "Sponsored similar (product page)" };

export const inr = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
export const pct = (n: number) => `${n.toLocaleString("en-IN", { maximumFractionDigits: 1 })}%`;

/** Today in IST as YYYY-MM-DD (kept out of components: `Date.now` is impure during render). */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
