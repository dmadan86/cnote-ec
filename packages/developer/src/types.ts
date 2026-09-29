import type { Scope } from "./scopes";

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

export interface UsageDay {
  day: string; // yyyy-mm-dd (UTC)
  requests: number;
  errors: number;
  mcpCalls: number;
}
