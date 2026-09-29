// @cnote/developer — personal API keys (Vercel/Supabase-style) for the public REST API + MCP.
// PUBLIC CONTRACT — apps/api, apps/web, apps/seller, apps/admin depend on these. Extend, don't break.
import type { ModuleWorker } from "@cnote/core";

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
] as const;
export type Scope = (typeof SCOPES)[number];

/** Expiry choices offered in the UI (like Vercel/Supabase tokens). */
export const EXPIRY_OPTIONS = ["1d", "7d", "30d", "90d", "1y", "never"] as const;
export type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

export interface ApiKeyView {
  id: string;
  name: string;
  prefix: string; // "ck_live_3fA9" — safe to display
  scopes: Scope[];
  businessId: string | null;
  expiresAt: string | null; // null = never
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: "active" | "expired" | "revoked";
}

/** The authenticated principal for an API request. */
export interface ApiPrincipal {
  keyId: string;
  personId: string;
  businessId: string | null;
  scopes: Scope[];
}

/** Creates a key; the full secret is returned ONCE and never stored (sha256 only). Max 25 active keys/person. */
export async function createApiKey(
  personId: string,
  input: { name: string; scopes: Scope[]; expiry: ExpiryOption; businessId?: string | null },
): Promise<{ key: ApiKeyView; secret: string }> {
  void personId; void input;
  throw new Error("not implemented");
}
export async function listApiKeys(personId: string): Promise<ApiKeyView[]> {
  void personId;
  throw new Error("not implemented");
}
export async function revokeApiKey(personId: string, keyId: string): Promise<void> {
  void personId; void keyId;
  throw new Error("not implemented");
}
/** Staff revoke (admin app wraps in audited()). */
export async function revokeApiKeyAsStaff(keyId: string, staffId: string): Promise<void> {
  void keyId; void staffId;
  throw new Error("not implemented");
}
/**
 * Verify a bearer secret: constant-time hash lookup (Redis-cached ~60s, revocation busts cache),
 * rejects expired/revoked, records usage (Redis counters). Returns null when invalid.
 */
export async function verifyApiKey(secret: string, ctx: { ip: string | null; kind: "rest" | "mcp" }): Promise<ApiPrincipal | null> {
  void secret; void ctx;
  throw new Error("not implemented");
}
/** True when the principal holds `scope` (":write" implies ":read"). */
export function hasScope(principal: Pick<ApiPrincipal, "scopes">, scope: Scope): boolean {
  if (principal.scopes.includes(scope)) return true;
  if (scope.endsWith(":read")) return principal.scopes.includes(scope.replace(":read", ":write") as Scope);
  return false;
}

export const worker: ModuleWorker = { name: "developer", handlers: {}, jobs: [] };
