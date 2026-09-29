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
  if (prod && env.CSP_REPORT_ONLY === "1") warnings.push("CSP_REPORT_ONLY=1: the CSP is not being enforced");
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
