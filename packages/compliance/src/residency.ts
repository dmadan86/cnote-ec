// Data-residency guard (ADR-010: "all personal data stored and processed in India regions").
// Composition roots (apps, worker) call `assertIndiaResidency()` at startup. With DATA_RESIDENCY_ENFORCE=true (set it in
// production) any configured endpoint that names a non-India cloud region throws; otherwise violations are only reported.
//
// Env: DATABASE_URL, LIVE_DATABASE_URL, REDIS_URL, MEDIA_DRIVER, MEDIA_REGION, MEDIA_ENDPOINT,
//      DATA_RESIDENCY_DB_HOST_ALLOW (regex the DB/Redis host must match, e.g. "\\.ap-south-1\\.rds\\.amazonaws\\.com$"),
//      DATA_RESIDENCY_R2_ACK=true (records the risk acceptance for Cloudflare R2, see below).
//
// Cloudflare R2: buckets are placed by "auto" location hints; R2 offers data-location jurisdictions only for EU and
// FedRAMP, NOT India. R2 therefore cannot be pinned to India: keep personal data (voice notes, KYC documents in the
// private bucket) on an India-region S3/GCS/Azure bucket, or accept the risk explicitly with DATA_RESIDENCY_R2_ACK=true.

export type CheckStatus = "ok" | "warn" | "violation";
export interface ResidencyCheck {
  name: string;
  /** host or region only, never credentials */
  value: string;
  status: CheckStatus;
  note: string;
}
export interface ResidencyReport {
  enforce: boolean;
  ok: boolean;
  checks: ResidencyCheck[];
}

export class ResidencyError extends Error {
  constructor(public readonly violations: ResidencyCheck[]) {
    super(`Data residency violation: ${violations.map((v) => `${v.name}=${v.value}`).join(", ")}`);
    this.name = "ResidencyError";
  }
}

/** Indian cloud regions across AWS, GCP, Azure and Oracle/Jio-style names. */
const INDIA = /(^|[^a-z0-9])(ap-south-[12]|asia-south[12]|centralindia|southindia|westindia|jioindiacentral|jioindiawest|ap-mumbai-1|ap-hyderabad-1|in-[a-z]+-\d|india)([^a-z0-9]|$)/i;
/** Tokens that name a region outside India. */
const FOREIGN = new RegExp(
  "(^|[^a-z0-9])(" +
    [
      "(?:us|eu|ap|ca|sa|me|af|il|mx)-(?:east|west|north|south|central|northeast|southeast|northwest|southwest)-\\d",
      "(?:asia|europe|us|northamerica|southamerica|australia|me|africa)-[a-z]+\\d+",
      "(?:eastus2?|westus[23]?|centralus|northcentralus|southcentralus|westeurope|northeurope|uksouth|ukwest|japaneast|japanwest|southeastasia|eastasia|australiaeast|canadacentral|brazilsouth|germanywestcentral|francecentral|swedencentral|uaenorth|koreacentral)",
    ].join("|") +
    ")([^a-z0-9]|$)",
  "i",
);
const LOCAL = /^(localhost|127\.0\.0\.1|\[?::1\]?|host\.docker\.internal|[a-z0-9-]+)$/i; // dotless names = docker/compose service hosts

const hostOf = (raw: string | undefined): string | null => {
  if (!raw) return null;
  try {
    const h = new URL(raw).hostname;
    if (h) return h;
  } catch {
    /* not a URL: fall through to bare host[:port] extraction */
  }
  return raw.replace(/^[a-z]+:\/\//i, "").split(/[/:?]/)[0] || null;
};

function checkHost(name: string, raw: string | undefined, env: NodeJS.ProcessEnv): ResidencyCheck | null {
  const host = hostOf(raw);
  if (!host) return null;
  const allow = env.DATA_RESIDENCY_DB_HOST_ALLOW;
  if (allow) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(allow, "i");
    } catch {
      /* invalid allowlist is reported below */
    }
    if (!re) return { name, value: host, status: "violation", note: "DATA_RESIDENCY_DB_HOST_ALLOW is not a valid regular expression" };
    return re.test(host)
      ? { name, value: host, status: "ok", note: "matches DATA_RESIDENCY_DB_HOST_ALLOW" }
      : { name, value: host, status: "violation", note: "host does not match DATA_RESIDENCY_DB_HOST_ALLOW" };
  }
  if (INDIA.test(host)) return { name, value: host, status: "ok", note: "India region" };
  if (FOREIGN.test(host)) return { name, value: host, status: "violation", note: "host names a non-India region" };
  if (LOCAL.test(host)) return { name, value: host, status: "ok", note: "local / private network host" };
  return { name, value: host, status: "warn", note: "region cannot be determined from the host name; set DATA_RESIDENCY_DB_HOST_ALLOW to verify" };
}

export function getResidencyReport(env: NodeJS.ProcessEnv = process.env): ResidencyReport {
  const checks: ResidencyCheck[] = [];
  for (const [name, key] of [["Database", "DATABASE_URL"], ["Live database", "LIVE_DATABASE_URL"], ["Redis", "REDIS_URL"]] as const) {
    const c = checkHost(name, env[key], env);
    if (c) checks.push(c);
  }
  const driver = (env.MEDIA_DRIVER || "local").toLowerCase();
  const region = env.MEDIA_REGION?.trim();
  const endpoint = hostOf(env.MEDIA_ENDPOINT);
  if (driver === "local") {
    checks.push({ name: "Media storage", value: "local disk", status: "ok", note: "local driver (development)" });
  } else if (driver === "r2") {
    const jurisdiction = endpoint && /\.(eu|fedramp)\.r2\.cloudflarestorage\.com$/i.test(endpoint);
    checks.push(
      jurisdiction
        ? { name: "Media storage (R2)", value: endpoint!, status: "violation", note: "R2 EU/FedRAMP jurisdiction endpoint" }
        : env.DATA_RESIDENCY_R2_ACK === "true"
          ? { name: "Media storage (R2)", value: endpoint ?? "auto", status: "warn", note: "R2 cannot be pinned to India; risk accepted via DATA_RESIDENCY_R2_ACK" }
          : { name: "Media storage (R2)", value: endpoint ?? "auto", status: "violation", note: "R2 cannot be pinned to India; use an India-region bucket for personal data or set DATA_RESIDENCY_R2_ACK=true" },
    );
  } else {
    const value = region || endpoint || "unset";
    const probe = `${region ?? ""} ${endpoint ?? ""}`;
    checks.push(
      INDIA.test(probe)
        ? { name: `Media storage (${driver})`, value, status: "ok", note: "India region" }
        : FOREIGN.test(probe)
          ? { name: `Media storage (${driver})`, value, status: "violation", note: "region/endpoint names a non-India region" }
          : { name: `Media storage (${driver})`, value, status: "violation", note: "MEDIA_REGION/MEDIA_ENDPOINT do not identify an India region" },
    );
  }
  if ((env.AI_PROVIDER || "heuristic") !== "heuristic") {
    checks.push({ name: "AI provider", value: env.AI_PROVIDER!, status: "warn", note: "external model calls: PII must be redacted first and the vendor needs an India endpoint or DPDP cross-border terms (ADR-008/010)" });
  }
  const enforce = env.DATA_RESIDENCY_ENFORCE === "true";
  return { enforce, ok: !checks.some((c) => c.status === "violation"), checks };
}

/** Startup guard: throws ResidencyError when enforcement is on and a violation exists. Always returns the report otherwise. */
export function assertIndiaResidency(env: NodeJS.ProcessEnv = process.env): ResidencyReport {
  const report = getResidencyReport(env);
  const violations = report.checks.filter((c) => c.status === "violation");
  if (violations.length) {
    if (report.enforce) throw new ResidencyError(violations);
    console.warn(`[compliance] data residency: ${violations.map((v) => `${v.name}=${v.value} (${v.note})`).join("; ")} (not enforced; set DATA_RESIDENCY_ENFORCE=true)`);
  }
  return report;
}
