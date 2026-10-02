// Legal entity and support contact details shown in the footer and on /contact (Consumer Protection (E-Commerce)
// Rules 2020 r.4(5)/r.5: name, registered address, support contact; IT Rules 2021 r.3(2): grievance officer).
// All values come from env so the real company details never live in code. Unset values render as a clearly marked
// placeholder in dev; production must configure them (see assertLegalEntity and .env.example).

export const ENTITY_ENV_KEYS = ["PLATFORM_LEGAL_NAME", "PLATFORM_CIN", "PLATFORM_GSTIN", "PLATFORM_ADDRESS", "SUPPORT_EMAIL", "SUPPORT_PHONE", "SUPPORT_WHATSAPP", "SUPPORT_HOURS"] as const;
export type EntityEnvKey = (typeof ENTITY_ENV_KEYS)[number];

export interface LegalEntity {
  legalName: string;
  cin: string;
  gstin: string;
  address: string;
  supportEmail: string;
  supportPhone: string;
  supportWhatsapp: string;
  supportHours: string;
  grievanceOfficerName: string | null;
  grievanceOfficerEmail: string | null;
  /** Env keys that are unset (their values above are placeholders). */
  missing: EntityEnvKey[];
}

type Env = Record<string, string | undefined>;

const LABEL: Record<EntityEnvKey, string> = {
  PLATFORM_LEGAL_NAME: "Legal name",
  PLATFORM_CIN: "CIN",
  PLATFORM_GSTIN: "GSTIN",
  PLATFORM_ADDRESS: "Registered address",
  SUPPORT_EMAIL: "Support email",
  SUPPORT_PHONE: "Support phone",
  SUPPORT_WHATSAPP: "WhatsApp number",
  SUPPORT_HOURS: "Support hours",
};

const clean = (v: string | undefined) => v?.trim() || undefined;

/** Env keys that are required for production and currently unset or blank. */
export function missingEntityEnv(env: Env = process.env): EntityEnvKey[] {
  return ENTITY_ENV_KEYS.filter((k) => !clean(env[k]));
}

/** True when the value is the dev placeholder for an unset key. */
export const isPlaceholder = (value: string) => /^\[.* not configured\]$/.test(value);

export function legalEntity(env: Env = process.env): LegalEntity {
  const get = (k: EntityEnvKey) => clean(env[k]) ?? `[${LABEL[k]} not configured]`;
  return {
    legalName: get("PLATFORM_LEGAL_NAME"),
    cin: get("PLATFORM_CIN"),
    gstin: get("PLATFORM_GSTIN"),
    address: get("PLATFORM_ADDRESS"),
    supportEmail: get("SUPPORT_EMAIL"),
    supportPhone: get("SUPPORT_PHONE"),
    supportWhatsapp: get("SUPPORT_WHATSAPP"),
    supportHours: get("SUPPORT_HOURS"),
    grievanceOfficerName: clean(env.GRIEVANCE_OFFICER_NAME) ?? null,
    grievanceOfficerEmail: clean(env.GRIEVANCE_OFFICER_EMAIL) ?? null,
    missing: missingEntityEnv(env),
  };
}

/** Production requires every entity detail: throws naming the unset keys. Dev and test never throw. */
export function assertLegalEntity(env: Env = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const missing = missingEntityEnv(env);
  if (missing.length) throw new Error(`Legal entity details are required in production, unset: ${missing.join(", ")} (see .env.example)`);
}

/**
 * Whether missing entity details stop the server from starting. Strict is the DEFAULT whenever NODE_ENV=production;
 * set LEGAL_ENTITY_STRICT=false to opt out (local production builds, preview deploys). Never strict outside production.
 */
export function isLegalEntityStrict(env: Env = process.env): boolean {
  return env.NODE_ENV === "production" && clean(env.LEGAL_ENTITY_STRICT)?.toLowerCase() !== "false";
}

/** digits and + only, for tel: and wa.me links. */
export const dialable = (v: string) => v.replace(/[^\d+]/g, "");
