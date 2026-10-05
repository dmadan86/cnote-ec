/** Feature scopes. `:write` implies `:read` for the same feature. */
export const SCOPES = [
  "profile:read",
  "catalogue:read",
  "search:read",
  "listings:read",
  "listings:write",
  "enquiries:read",
  "enquiries:write",
  "leads:read",
  "leads:write",
  "messages:read",
  "messages:write",
  "wishlist:read",
  "wishlist:write",
  "reviews:read",
  "reviews:write",
  "billing:read",
  "agents:read",
  "agents:write",
  "samples:read",
  "samples:write",
  "contracts:read",
  "contracts:write",
] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(v: unknown): v is Scope {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}

/** Write scopes that act as the person themselves and need no business. */
const PERSON_LEVEL_WRITES: readonly Scope[] = ["wishlist:write", "reviews:write", "messages:write"];
/** Read scopes that expose business-owned data (need a business to be meaningful). */
const BUSINESS_READS: readonly Scope[] = ["leads:read", "billing:read", "listings:read", "agents:read", "contracts:read", "samples:read"];

/** True when holding `scope` requires the key to be bound to a business. */
export function scopeNeedsBusiness(scope: Scope): boolean {
  if (scope.endsWith(":write")) return !PERSON_LEVEL_WRITES.includes(scope);
  return BUSINESS_READS.includes(scope);
}

export type ScopeFeature =
  | "profile" | "catalogue" | "search" | "listings" | "enquiries" | "leads" | "messages" | "wishlist" | "reviews" | "billing" | "agents" | "contracts" | "samples";

export interface ScopeGroup {
  label: string;
  description: string;
  read?: Scope;
  write?: Scope;
  /** Whether choosing read / write for this feature requires a business. */
  businessScoped: { read: boolean; write: boolean };
}

const g = (label: string, description: string, read?: Scope, write?: Scope): ScopeGroup => ({
  label,
  description,
  read,
  write,
  businessScoped: { read: read ? scopeNeedsBusiness(read) : false, write: write ? scopeNeedsBusiness(write) : false },
});

/** Feature → scopes, for token-creation UIs (None / Read / Read & write per feature). */
export const SCOPE_GROUPS: Record<ScopeFeature, ScopeGroup> = {
  profile: g("Profile", "Your account and business profile.", "profile:read"),
  catalogue: g("Catalogue", "Browse categories and public listings.", "catalogue:read"),
  search: g("Search", "Search listings and sellers.", "search:read"),
  listings: g("Listings", "Your business's listings.", "listings:read", "listings:write"),
  enquiries: g("Enquiries", "Enquiries you have sent or received.", "enquiries:read", "enquiries:write"),
  leads: g("Leads", "Matched buyer leads for your business.", "leads:read", "leads:write"),
  messages: g("Messages", "Conversations with buyers and sellers.", "messages:read", "messages:write"),
  wishlist: g("Wishlist", "Saved items and lists.", "wishlist:read", "wishlist:write"),
  reviews: g("Reviews", "Reviews you wrote or received.", "reviews:read", "reviews:write"),
  billing: g("Billing", "Credits balance and invoices.", "billing:read"),
  agents: g("Agents", "Agent-to-agent negotiation for your business (ADR-020). Deals still need human confirmation.", "agents:read", "agents:write"),
  samples: g("Samples", "Sample requests before a bulk order: ask for, answer, dispatch and evaluate samples (docs/design/samples.md).", "samples:read", "samples:write"),
  contracts: g("Rate contracts", "Agreed-price contracts between your business and a counterparty: read them and place call-off orders at the contract prices (docs/design/rate-contracts.md).", "contracts:read", "contracts:write"),
};

/** Features offered on the buyer (web) and seller developer pages. */
export const BUYER_FEATURES: ScopeFeature[] = ["profile", "catalogue", "search", "enquiries", "messages", "wishlist", "reviews", "agents", "contracts", "samples"];
export const SELLER_FEATURES: ScopeFeature[] = ["listings", "leads", "messages", "billing", "reviews", "catalogue", "search", "agents", "contracts", "samples"];

/** Scopes for a form's per-feature choice ("none" | "read" | "write"); write implies read. Unknown features ignored. */
export function scopesFromAccess(access: Record<string, string | null | undefined>): Scope[] {
  const out = new Set<Scope>();
  for (const [feature, level] of Object.entries(access)) {
    const group = (SCOPE_GROUPS as Record<string, ScopeGroup | undefined>)[feature];
    if (!group) continue;
    if (level === "write" && group.write) out.add(group.write);
    else if ((level === "read" || level === "write") && group.read) out.add(group.read);
  }
  return [...out];
}

/** True when the principal holds `scope` (":write" implies ":read"). */
export function hasScope(principal: { scopes: readonly Scope[] }, scope: Scope): boolean {
  if (principal.scopes.includes(scope)) return true;
  if (scope.endsWith(":read")) return principal.scopes.includes(scope.replace(":read", ":write") as Scope);
  return false;
}

/** Plain-data group definitions for the token UI (`CreateApiKeyForm` `groups` prop). */
export function scopeGroupDefs(features: readonly ScopeFeature[]) {
  return features.map((feature) => {
    const g = SCOPE_GROUPS[feature];
    return {
      feature, label: g.label, description: g.description,
      hasRead: g.read !== undefined, hasWrite: g.write !== undefined,
      businessRead: g.businessScoped.read, businessWrite: g.businessScoped.write,
    };
  });
}
