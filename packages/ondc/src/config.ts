// ONDC participant configuration (ADR-017). Everything comes from env; private keys are never persisted.
// ONDC_ENABLED defaults to false: with it off nothing is published and inbound routes answer 404.
import { edPublicFromPrivate } from "./crypto";

export type OndcEnv = "staging" | "preprod" | "prod";
type Env = Record<string, string | undefined>;

export const REGISTRY_URLS: Record<OndcEnv, string> = {
  staging: "https://staging.registry.ondc.org",
  preprod: "https://preprod.registry.ondc.org/ondc",
  prod: "https://prod.registry.ondc.org/ondc",
};

export interface OndcConfig {
  enabled: boolean;
  env: OndcEnv;
  registryUrl: string;
  subscriberId: string;
  uniqueKeyId: string;
  /** public URL that ONDC calls (base of /search, /select, ...) */
  subscriberUrl: string;
  signingPrivateKey: string | null;
  signingPublicKey: string | null;
  encryptionPrivateKey: string | null;
  encryptionPublicKey: string | null;
  /** ONDC's published x25519 public key for the registry (env specific); used to answer on_subscribe */
  registryEncryptionPublicKey: string | null;
  domains: string[];
  cityCodes: string[];
  country: string;
  coreVersion: string;
  ttl: string;
  /** lifetime of signatures we produce, seconds */
  signatureTtlSeconds: number;
  /** allow http:// callback URLs (never in prod) */
  allowHttp: boolean;
  categoryMap: Record<string, string>;
}

const list = (v: string | undefined, dflt: string[]): string[] => {
  const out = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return out.length ? out : dflt;
};

export function loadConfig(env: Env = process.env): OndcConfig {
  const e = (env.ONDC_ENV ?? "staging") as OndcEnv;
  const which: OndcEnv = e === "prod" || e === "preprod" ? e : "staging";
  let categoryMap: Record<string, string> = {};
  try {
    const parsed: unknown = env.ONDC_CATEGORY_MAP ? JSON.parse(env.ONDC_CATEGORY_MAP) : {};
    if (parsed && typeof parsed === "object") categoryMap = Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    categoryMap = {};
  }
  const signingPrivateKey = env.ONDC_SIGNING_PRIVATE_KEY?.trim() || null;
  return {
    enabled: env.ONDC_ENABLED === "true" || env.ONDC_ENABLED === "1",
    env: which,
    registryUrl: (env.ONDC_REGISTRY_URL?.trim() || REGISTRY_URLS[which]).replace(/\/+$/, ""),
    subscriberId: env.ONDC_SUBSCRIBER_ID?.trim() ?? "",
    uniqueKeyId: env.ONDC_UNIQUE_KEY_ID?.trim() ?? "",
    subscriberUrl: (env.ONDC_SUBSCRIBER_URL?.trim() ?? "").replace(/\/+$/, ""),
    signingPrivateKey,
    signingPublicKey: signingPrivateKey ? safePub(signingPrivateKey) : null,
    encryptionPrivateKey: env.ONDC_ENCRYPTION_PRIVATE_KEY?.trim() || null,
    encryptionPublicKey: env.ONDC_ENCRYPTION_PUBLIC_KEY?.trim() || null,
    registryEncryptionPublicKey: env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY?.trim() || null,
    domains: list(env.ONDC_DOMAINS, ["ONDC:RET10"]),
    cityCodes: list(env.ONDC_CITY_CODES, ["*"]),
    country: env.ONDC_COUNTRY?.trim() || "IND",
    coreVersion: env.ONDC_CORE_VERSION?.trim() || "1.2.0",
    ttl: env.ONDC_TTL?.trim() || "PT30S",
    signatureTtlSeconds: Math.min(3600, Math.max(30, Number(env.ONDC_SIGNATURE_TTL_SECONDS) || 300)),
    allowHttp: which !== "prod" && env.ONDC_ALLOW_HTTP === "true",
    categoryMap,
  };
}

function safePub(priv: string): string | null {
  try {
    return edPublicFromPrivate(priv);
  } catch {
    return null;
  }
}

/** Feature flag. Read on every call so tests and ops toggles apply without a restart. */
export const isEnabled = (env: Env = process.env): boolean => loadConfig(env).enabled;

export interface ConfigStatus {
  enabled: boolean;
  env: OndcEnv;
  registryUrl: string;
  subscriberId: string | null;
  uniqueKeyId: string | null;
  subscriberUrl: string | null;
  domains: string[];
  cityCodes: string[];
  signingKey: "configured" | "missing" | "invalid";
  encryptionKey: "configured" | "missing";
  missing: string[];
  ready: boolean;
}

/** What the admin console shows: presence of secrets, never their values. */
export function configStatus(cfg: OndcConfig = loadConfig()): ConfigStatus {
  const missing: string[] = [];
  if (!cfg.subscriberId) missing.push("ONDC_SUBSCRIBER_ID");
  if (!cfg.uniqueKeyId) missing.push("ONDC_UNIQUE_KEY_ID");
  if (!cfg.subscriberUrl) missing.push("ONDC_SUBSCRIBER_URL");
  if (!cfg.signingPrivateKey) missing.push("ONDC_SIGNING_PRIVATE_KEY");
  if (!cfg.encryptionPrivateKey) missing.push("ONDC_ENCRYPTION_PRIVATE_KEY");
  if (!cfg.encryptionPublicKey) missing.push("ONDC_ENCRYPTION_PUBLIC_KEY");
  const signingKey = !cfg.signingPrivateKey ? "missing" : cfg.signingPublicKey ? "configured" : "invalid";
  return {
    enabled: cfg.enabled, env: cfg.env, registryUrl: cfg.registryUrl,
    subscriberId: cfg.subscriberId || null, uniqueKeyId: cfg.uniqueKeyId || null, subscriberUrl: cfg.subscriberUrl || null,
    domains: cfg.domains, cityCodes: cfg.cityCodes,
    signingKey, encryptionKey: cfg.encryptionPrivateKey && cfg.encryptionPublicKey ? "configured" : "missing",
    missing, ready: missing.length === 0 && signingKey === "configured",
  };
}
