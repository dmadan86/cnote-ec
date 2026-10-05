// Secrets port + start-up validator. Apps read secrets from process.env; a SecretsProvider is how a
// deployment sources them (Cloudflare/Vercel env, AWS Secrets Manager, Azure Key Vault, GCP Secret Manager,
// Doppler). `loadSecretsIntoEnv` hydrates env from a provider once at boot, then `assertRequiredSecrets`
// fails fast in production if anything is missing or weak.

export interface SecretsProvider {
  readonly name: string;
  get(key: string): Promise<string | undefined>;
}

export const envSecrets: SecretsProvider = { name: "env", get: async (key) => process.env[key] };

function stub(name: string, how: string): SecretsProvider {
  return {
    name,
    get: async () => {
      throw new Error(`${name} secrets adapter is not implemented. ${how}`);
    },
  };
}
/** AWS Secrets Manager: `GetSecretValue({ SecretId: prefix + key })`; cache in memory, rotate via staging labels. */
export const awsSecretsManager = () => stub("aws-secrets-manager", "Use @aws-sdk/client-secrets-manager GetSecretValue.");
/** Azure Key Vault: `SecretClient.getSecret(name)` with a managed identity (no client secrets). */
export const azureKeyVaultSecrets = () => stub("azure-key-vault", "Use @azure/keyvault-secrets SecretClient.getSecret.");
/** GCP Secret Manager: `accessSecretVersion({ name: projects/<id>/secrets/<key>/versions/latest })`. */
export const gcpSecretManager = () => stub("gcp-secret-manager", "Use @google-cloud/secret-manager accessSecretVersion.");
/** Doppler: simplest is `doppler run -- <cmd>` which injects env (use envSecrets); or the REST API with a service token. */
export const dopplerSecrets = () => stub("doppler", "Prefer `doppler run --` (env injection) and use envSecrets.");

/** Copy secrets from a provider into process.env (only keys not already set). Call once at boot. */
export async function loadSecretsIntoEnv(provider: SecretsProvider, keys: readonly string[]): Promise<void> {
  for (const k of keys) {
    if (process.env[k]) continue;
    const v = await provider.get(k);
    if (v) process.env[k] = v;
  }
}

// ---------- validation ----------
export type SecretsApp = "web" | "seller" | "admin" | "studio" | "api" | "worker";
type Env = Record<string, string | undefined>;
export interface SecretsReport {
  errors: string[];
  warnings: string[];
}

const WEAK_MARKERS = /(change[-_ ]?me|dev[-_ ]?only|insecure|example|password|secret[-_ ]?key|placeholder|default|test)/i;

/** Low-entropy heuristic: too few distinct characters, or an obvious placeholder. */
export function isWeakSecret(value: string): boolean {
  return value.length < 32 || new Set(value).size < 10 || WEAK_MARKERS.test(value);
}

const REALM_ENV = { web: "JWT_SECRET_WEB", seller: "JWT_SECRET_SELLER", admin: "JWT_SECRET_ADMIN" } as const;
const APP_REALM: Partial<Record<SecretsApp, keyof typeof REALM_ENV>> = { web: "web", seller: "seller", studio: "seller", admin: "admin" };

const truthy = (v: string | undefined): boolean => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function urlOf(raw: string | undefined): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/** Transport security for the data stores (audit M8): TLS to Postgres and Redis unless on loopback or explicitly waived. */
function validateTransport(env: Env, errors: string[]): void {
  for (const key of ["DATABASE_URL", "LIVE_DATABASE_URL"] as const) {
    const u = urlOf(env[key]);
    if (!u || LOCAL_HOSTS.has(u.hostname)) continue;
    const mode = (u.searchParams.get("sslmode") ?? "").toLowerCase();
    if (!["require", "verify-full", "verify-ca"].includes(mode) && !truthy(env.DB_TLS_OPTIONAL)) {
      errors.push(`${key} has no TLS: add ?sslmode=require (or verify-full), or set DB_TLS_OPTIONAL=1 if the database is on a private network and that is documented`);
    }
  }
  const redis = urlOf(env.REDIS_URL);
  if (redis && !LOCAL_HOSTS.has(redis.hostname) && redis.protocol !== "rediss:" && !truthy(env.REDIS_TLS_OPTIONAL)) {
    errors.push("REDIS_URL must be rediss:// (TLS), or set REDIS_TLS_OPTIONAL=1 if Redis is on a private network and that is documented");
  }
}

/** Production-only checks on dev conveniences and on the secrets that enabled providers need to verify their webhooks. */
function validateProductionFlags(env: Env, errors: string[], warnings: string[]): void {
  if (truthy(env.OTP_DEV_ECHO)) {
    // Non-production deployments that run NODE_ENV=production (the Playwright e2e servers read the OTP off the screen; the dev k8s
    // overlay) opt out explicitly. A real deployment must never set ALLOW_OTP_ECHO_IN_PRODUCTION.
    const msg = "OTP_DEV_ECHO=true returns one-time codes in API responses: never enable it in production";
    if (truthy(env.ALLOW_OTP_ECHO_IN_PRODUCTION)) warnings.push(`${msg} (allowed by ALLOW_OTP_ECHO_IN_PRODUCTION=1: e2e/dev only)`);
    else errors.push(msg);
  }

  const need = (cond: boolean, what: string, ...keys: string[]) => {
    if (!cond) return;
    for (const k of keys) if (!env[k]) errors.push(`${k} is not set: ${what} cannot verify webhooks without it`);
  };
  const payments = (env.PAYMENTS_PROVIDER ?? "mock").trim().toLowerCase();
  need(payments === "razorpay", "the Razorpay payments provider", "RAZORPAY_WEBHOOK_SECRET");
  need(payments === "cashfree", "the Cashfree payments provider", "CASHFREE_WEBHOOK_SECRET");
  need(truthy(env.ESCROW_ENABLED), "escrow (ESCROW_ENABLED)", "ESCROW_WEBHOOK_SECRET");
  need(truthy(env.CREDIT_ENABLED), "credit (CREDIT_ENABLED)", "CREDIT_WEBHOOK_SECRET");
  need(!!env.KYC_PROVIDER && env.KYC_PROVIDER.trim().toLowerCase() !== "mock", "the KYC provider", "KYC_WEBHOOK_SECRET");
  const whatsappOn = (env.WHATSAPP_PROVIDER ?? (env.WHATSAPP_ACCESS_TOKEN ? "meta_cloud" : "mock")).toLowerCase() === "meta_cloud";
  need(whatsappOn, "the WhatsApp channel", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN");

  if (env.REVALIDATE_SECRET && env.REVALIDATE_SECRET.length < 32) errors.push("REVALIDATE_SECRET is weak (need 32+ random characters)");
  const customDomains = ["cloudflare", "vercel", "aws"].includes((env.EDGE_PROVIDER ?? "mock").trim().toLowerCase()) || truthy(env.DOMAINS_HTTP_PROBE);
  need(customDomains, "custom domains (EDGE_PROVIDER / DOMAINS_HTTP_PROBE)", "DOMAIN_CHECK_SECRET");

  if (env.CSP_REPORT_ONLY === "1") {
    if (truthy(env.CSP_REPORT_ONLY_ACK)) warnings.push("CSP_REPORT_ONLY=1 (acknowledged): the CSP is not being enforced");
    else errors.push("CSP_REPORT_ONLY=1 leaves the CSP unenforced: finish the rollout, or set CSP_REPORT_ONLY_ACK=1 to acknowledge it");
  }
}

/**
 * WebAuthn relying-party config (ADR-029/042, docs/design/admin-passkeys.md). When a realm turns passkeys on
 * (`<REALM>_PASSKEYS_ENABLED` or `<REALM>_REQUIRE_PASSKEY`), its own app must be told the exact https origin and RP ID:
 * a wrong RP ID silently locks everyone out of their passkeys, and a loose one weakens the phishing protection.
 */
function validatePasskeys(app: SecretsApp, env: Env, errors: string[]): void {
  if (app !== "admin" && app !== "seller" && app !== "web") return;
  const p = app.toUpperCase();
  if (!truthy(env[`${p}_PASSKEYS_ENABLED`]) && !truthy(env[`${p}_REQUIRE_PASSKEY`])) return;
  const rpKey = `${p}_WEBAUTHN_RP_ID`;
  const originKey = `${p}_WEBAUTHN_ORIGIN`;
  const rpId = env[rpKey]?.trim().toLowerCase();
  if (!rpId) errors.push(`${rpKey} is not set: passkeys are enabled for ${app} (set the registrable domain, e.g. example.com)`);
  if (!env[originKey]) errors.push(`${originKey} is not set: passkeys are enabled for ${app} (exact https origin, e.g. https://admin.example.com)`);
  const origin = urlOf(env[originKey]);
  if (env[originKey] && (!origin || origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash)) {
    errors.push(`${originKey} must be a bare https origin (scheme + host, no path)`);
  } else if (origin && rpId) {
    if (LOCAL_HOSTS.has(origin.hostname)) errors.push(`${originKey} must not be localhost in production`);
    else if (origin.hostname !== rpId && !origin.hostname.endsWith(`.${rpId}`)) errors.push(`${rpKey} (${rpId}) must equal or be a parent domain of the host in ${originKey} (${origin.hostname})`);
  }
  if (rpId && (/^[\d.]+$/.test(rpId) || rpId.includes(":") || rpId.includes("/"))) errors.push(`${rpKey} must be a domain name, not an IP address, port or URL`);
}

export function validateSecrets(app: SecretsApp, env: Env = process.env): SecretsReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const prod = env.NODE_ENV === "production";
  const bad = (msg: string) => (prod ? errors : warnings).push(msg);

  const realm = APP_REALM[app];
  if (realm) {
    const dedicated = env[REALM_ENV[realm]];
    const master = env.JWT_SECRET;
    const used = dedicated || master;
    if (!used) bad(`${REALM_ENV[realm]} (or JWT_SECRET) is not set`);
    else if (isWeakSecret(used)) bad(`${dedicated ? REALM_ENV[realm] : "JWT_SECRET"} is weak (need 32+ random characters, no placeholder text)`);
    // Realm isolation: dedicated secrets must be distinct from each other and from the master.
    const dedicatedAll = (Object.values(REALM_ENV) as string[]).flatMap((k): [string, string][] => (env[k] ? [[k, env[k]!]] : []));
    const seen = new Map<string, string>();
    for (const [k, v] of dedicatedAll) {
      const clash = seen.get(v) ?? (master && v === master ? "JWT_SECRET" : undefined);
      if (clash) bad(`${k} must differ from ${clash} (each realm needs its own signing key)`);
      seen.set(v, k);
    }
    if (prod && !dedicated) warnings.push(`${REALM_ENV[realm]} is not set: falling back to a key derived from JWT_SECRET (set per-realm secrets)`);
  }

  if (prod) {
    if (!env.DATABASE_URL) errors.push("DATABASE_URL is not set");
    if (!env.REDIS_URL) errors.push("REDIS_URL is not set (sessions, rate limits and queues need it)");
    validateTransport(env, errors);
    validateProductionFlags(env, errors, warnings);
    validatePasskeys(app, env, errors);
  }

  const usesFieldCrypto = app !== "studio";
  if (usesFieldCrypto && (env.FIELD_KMS ?? "local").toLowerCase() === "local") {
    const spec = env.FIELD_ENCRYPTION_KEYS;
    if (!spec) bad("FIELD_ENCRYPTION_KEYS is not set (format kid:base64key[,kid2:base64key])");
    else {
      const kids = new Set<string>();
      for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
        const i = part.indexOf(":");
        const kid = part.slice(0, i);
        if (i < 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(kid)) bad(`FIELD_ENCRYPTION_KEYS: invalid key id near "${part.slice(0, 8)}"`);
        else if (Buffer.from(part.slice(i + 1), "base64").length !== 32) bad(`FIELD_ENCRYPTION_KEYS: key "${kid}" must decode to 32 bytes`);
        if (kids.has(kid)) bad(`FIELD_ENCRYPTION_KEYS: duplicate key id "${kid}"`);
        kids.add(kid);
      }
      if (env.FIELD_ENCRYPTION_ACTIVE_KID && !kids.has(env.FIELD_ENCRYPTION_ACTIVE_KID)) bad("FIELD_ENCRYPTION_ACTIVE_KID is not in FIELD_ENCRYPTION_KEYS");
    }
  }
  if (usesFieldCrypto) {
    const bi = env.BLIND_INDEX_KEY;
    if (!bi) bad("BLIND_INDEX_KEY is not set (base64, 32+ bytes)");
    else if (Buffer.from(bi, "base64").length < 32) bad("BLIND_INDEX_KEY must decode to at least 32 bytes");
  }

  const verifier = (env.HUMAN_VERIFIER ?? "turnstile").toLowerCase(); // same normalisation as getHumanVerifier
  if ((app === "web" || app === "seller") && verifier !== "off" && prod) {
    const key = verifier === "hcaptcha" ? "HCAPTCHA_SECRET" : verifier === "recaptcha" ? "RECAPTCHA_SECRET" : "TURNSTILE_SECRET";
    if (!env[key]) errors.push(`${key} is not set: sign-up and OTP requests will be rejected (set HUMAN_VERIFIER=off to disable bot protection explicitly)`);
    if (!env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && key === "TURNSTILE_SECRET") errors.push("NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set: the widget cannot render");
  }
  return { errors, warnings };
}

/**
 * Start-up guard. Production: throws listing every problem. Elsewhere: logs warnings and continues.
 * Call from each app's instrumentation `register()` (Node runtime, not during `next build`) and the worker's boot.
 */
export function assertRequiredSecrets(app: SecretsApp, env: Env = process.env): SecretsReport {
  const report = validateSecrets(app, env);
  for (const w of report.warnings) console.warn(`[security] ${w}`);
  if (report.errors.length) throw new Error(`Refusing to start ${app}: insecure or missing configuration\n - ${report.errors.join("\n - ")}`);
  return report;
}
