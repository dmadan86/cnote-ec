// @cnote/developer — personal API keys (Vercel/Supabase-style) for the public REST API + MCP.
// PUBLIC CONTRACT — apps/api, apps/web, apps/seller, apps/admin depend on these. Extend, don't break.
export {
  SCOPES, SCOPE_GROUPS, BUYER_FEATURES, SELLER_FEATURES, hasScope, isScope, scopeNeedsBusiness, scopesFromAccess, scopeGroupDefs,
  type Scope, type ScopeFeature, type ScopeGroup,
} from "./scopes";
export { EXPIRY_OPTIONS, EXPIRY_LABELS, expiryToDate, type ExpiryOption } from "./expiry";
export type { ApiKeyView, ApiPrincipal, UsageDay } from "./types";
export { createApiKey, listApiKeys, revokeApiKey, revokeApiKeyAsStaff, revokeAllApiKeysForPerson, MAX_ACTIVE_KEYS } from "./keys";
export { verifyApiKey } from "./verify";
export { recordApiError, getKeyUsage, flushApiKeyUsage, hasApiKeyActivitySince } from "./usage";
export { listApiKeysForStaff, type StaffApiKeyView } from "./staff";
export { worker } from "./worker";
