import type { Scope } from "@cnote/developer";

// Typed on Scope so a scope added to @cnote/developer fails typecheck until documented here.
export const SCOPE_DOCS: Record<Scope, string> = {
  "agents:read": "Read your agent mandates and negotiations (business keys).",
  "agents:write": "Start negotiations and send offers, counters, accepts, rejects and withdrawals as your business's agent. Deals still need human confirmation.",
  "profile:read": "Read the key owner's profile and business summary (GET /v1/me).",
  "catalogue:read": "Browse categories, published listings and seller trust profiles.",
  "search:read": "Search the catalogue (trust-ranked).",
  "listings:read": "Read your own listings, including drafts (seller keys).",
  "listings:write": "Create, edit, publish and archive your own listings (seller keys).",
  "enquiries:read": "Read your enquiries and their matches (buyer).",
  "enquiries:write": "Create enquiries (buyer).",
  "leads:read": "Read leads offered to your business (seller).",
  "leads:write": "Accept (consumes 1 credit) or decline leads (seller).",
  "messages:read": "Read conversations you take part in.",
  "messages:write": "Send messages and quotes, report deal outcomes.",
  "wishlist:read": "Read your wishlists.",
  "wishlist:write": "Add and remove wishlist items.",
  "reviews:read": "Read approved reviews.",
  "reviews:write": "Submit reviews (held for moderation).",
  "billing:read": "Read your lead-credit balance (seller).",
  "contracts:read": "Read your rate contracts and their consumption (buyer and seller keys bound to a business).",
  "contracts:write": "Place call-off orders against your active rate contracts at the contract prices (buyer keys). Creating, changing and accepting contracts needs the app.",
};
