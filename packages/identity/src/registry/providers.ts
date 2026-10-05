// Udyam (MSME) and MCA (company master data) registry providers (ADR-003 T1). Ports + deterministic mock (default) + Surepass.
// There is no open public API for either: Udyam's portal is captcha/OTP-gated and MCA master data is paywalled, so
// production goes through a KYC/KYB vendor. Same pattern as the GST port (gst/providers.ts).
//
// Env: UDYAM_PROVIDER / MCA_PROVIDER = mock (default, refused in production) | surepass
//      REGISTRY_PROVIDER_KEY (Surepass bearer token), REGISTRY_PROVIDER_BASE_URL (default https://kyc-api.surepass.io),
//      REGISTRY_PROVIDER_TIMEOUT_MS (default 8000).
//
// Surepass: public pages only list "Udyam Aadhaar Verification" (https://surepass.io/udyam-aadhaar-verification-api/) and
// "MCA Data APIs (CIN / DIN)" (https://surepass.io/mca-data-apis-cin-din-v3-portal/); request/response schemas are shared
// after signup (https://surepass.io/get-api-key/). The paths and field names below follow Surepass' bearer-token REST
// convention used by their GSTIN API and are UNCONFIRMED: `parseSurepassUdyam` / `parseSurepassMca` and the two PATH
// constants are the only places to adjust once the account docs are in hand. See docs/design/verification-t2-t3.md.
import { DomainError } from "@cnote/core";
import { assertPublicHttpTarget, pinnedFetch } from "@cnote/security";
import { GstnProviderError } from "../gstin";
import { withCircuitBreaker } from "../gst/providers";
import type { AddressParts } from "./match";

export const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;
export { CIN_RE } from "../gst/normalise";

export type RegistryError = GstnProviderError;
export const RegistryProviderError = GstnProviderError;

export type UdyamStatus = "Active" | "Cancelled" | "Inactive";
export interface UdyamRecord {
  udyamNumber: string;
  enterpriseName: string;
  /** micro | small | medium as reported */
  enterpriseType?: string;
  /** proprietorship / partnership / private limited ... as reported */
  organisationType?: string;
  majorActivity?: string;
  incorporationDate?: string;
  status: UdyamStatus;
  address: AddressParts;
}
export type McaStatus = "Active" | "Struck Off" | "Under Liquidation" | "Amalgamated" | "Inactive";
export interface McaRecord {
  cin: string;
  companyName: string;
  status: McaStatus;
  classOfCompany?: string;
  incorporationDate?: string;
  rocCode?: string;
  address: AddressParts;
}

/** Hints the mock echoes (so dev onboarding passes); real adapters ignore them. */
export interface RegistryLookupOpts { businessName?: string; address?: AddressParts }
export interface UdyamProvider { name: string; lookup(udyam: string, opts?: RegistryLookupOpts): Promise<UdyamRecord | null> }
export interface McaProvider { name: string; lookup(cin: string, opts?: RegistryLookupOpts): Promise<McaRecord | null> }

// ---------- mock ----------
/**
 * Deterministic dev/CI providers, keyed on the LAST character of the number:
 *   Udyam (7 digits): 0 not found · 1 cancelled · 2 name mismatch · 3 provider unavailable · other: Active, echoing the declared name.
 *   CIN (final digit of the 6-digit serial): 0 not found · 1 struck off · 2 name mismatch · 3 provider unavailable · other: Active.
 * `opts.businessName/address` echo the declared profile (so dev onboarding passes). Tests pin exact records with `setFixture`.
 */
export interface MockUdyamProvider extends UdyamProvider { setFixture(n: string, r: UdyamRecord | null): void; clearFixtures(): void }
export function createMockUdyamProvider(): MockUdyamProvider {
  const fixtures = new Map<string, UdyamRecord | null>();
  return {
    name: "mock",
    setFixture: (n, r) => void fixtures.set(n, r),
    clearFixtures: () => fixtures.clear(),
    async lookup(udyam, opts) {
      if (fixtures.has(udyam)) return fixtures.get(udyam) ?? null;
      const c = udyam.slice(-1);
      if (c === "0") return null;
      if (c === "3") throw new GstnProviderError("unavailable", "mock udyam provider unavailable");
      return {
        udyamNumber: udyam,
        enterpriseName: c === "2" ? "Completely Different Enterprises" : opts?.businessName ?? "Mock Enterprises",
        enterpriseType: "micro", organisationType: "proprietorship", majorActivity: "Manufacturing", incorporationDate: "2020-04-01",
        status: c === "1" ? "Cancelled" : "Active",
        address: opts?.address ?? {},
      };
    },
  };
}
export interface MockMcaProvider extends McaProvider { setFixture(n: string, r: McaRecord | null): void; clearFixtures(): void }
export function createMockMcaProvider(): MockMcaProvider {
  const fixtures = new Map<string, McaRecord | null>();
  return {
    name: "mock",
    setFixture: (n, r) => void fixtures.set(n, r),
    clearFixtures: () => fixtures.clear(),
    async lookup(cin, opts) {
      if (fixtures.has(cin)) return fixtures.get(cin) ?? null;
      const c = cin.slice(-1);
      if (c === "0") return null;
      if (c === "3") throw new GstnProviderError("unavailable", "mock mca provider unavailable");
      return {
        cin,
        companyName: c === "2" ? "Completely Different Industries Private Limited" : opts?.businessName ?? "Mock Industries Private Limited",
        status: c === "1" ? "Struck Off" : "Active",
        classOfCompany: "Private", incorporationDate: "2018-06-15", rocCode: "RoC-Mumbai",
        address: opts?.address ?? {},
      };
    },
  };
}
export const mockUdyamProvider = createMockUdyamProvider();
export const mockMcaProvider = createMockMcaProvider();

// ---------- shared HTTP (SSRF-safe: validated target + DNS-pinned connect; timeout; 2 retries on timeout/5xx) ----------
interface HttpCfg { baseUrl: string; timeoutMs: number; retries: number; fetchImpl?: typeof fetch }
async function registryJson(path: string, token: string, payload: unknown, cfg: HttpCfg): Promise<{ status: number; body: unknown }> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  const init: RequestInit = { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(payload) };
  let last: unknown;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    try {
      const res = cfg.fetchImpl
        ? await cfg.fetchImpl(url, { ...init, signal: AbortSignal.timeout(cfg.timeoutMs) })
        : await pinnedFetch(await assertPublicHttpTarget(url), { ...init, timeoutMs: cfg.timeoutMs });
      if (res.status >= 500) throw new GstnProviderError("unavailable", `provider HTTP ${res.status}`);
      if (res.status === 429) throw new GstnProviderError("rate_limited", "provider rate limit exceeded");
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { throw new GstnProviderError("bad_response", "provider returned non-JSON"); }
      return { status: res.status, body };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      last = name === "AbortError" || name === "TimeoutError" ? new GstnProviderError("timeout", `provider timed out after ${cfg.timeoutMs}ms`) : err;
      const retryable = last instanceof GstnProviderError ? last.kind === "timeout" || last.kind === "unavailable" : false;
      if (!retryable || attempt === cfg.retries) break;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.floor(Math.random() * 100)));
    }
  }
  throw last instanceof GstnProviderError ? last : new GstnProviderError("unavailable", `provider request failed: ${(last as Error)?.message ?? last}`);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const first = (o: Record<string, unknown>, ...keys: string[]): string | undefined => { for (const k of keys) { const v = str(o[k]); if (v) return v; } return undefined; };
const isoDate = (v: unknown): string | undefined => {
  const s = str(v);
  const m = s && (s.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/));
  return m ? (m[1]!.length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`) : undefined;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const addr = (...candidates: unknown[]): AddressParts => {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return { line: c.trim() };
    const o = obj(c);
    if (Object.keys(o).length) {
      const line = first(o, "address", "full_address", "line", "address_line1", "flat", "door_no");
      const parts = [first(o, "flat", "building", "road", "village", "block", "area"), first(o, "address_line1"), first(o, "address_line2")].filter(Boolean).join(", ");
      return { line: line ?? (parts || undefined), city: first(o, "city", "district", "dist"), state: first(o, "state"), pincode: first(o, "pincode", "pin", "pin_code") };
    }
  }
  return {};
};

// ---------- Surepass ----------
export const SUREPASS_UDYAM_PATH = "/api/v1/corporate/udyog-aadhaar"; // UNCONFIRMED: set per account docs
export const SUREPASS_MCA_PATH = "/api/v1/corporate/company-details"; // UNCONFIRMED: set per account docs

function cfgFrom(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): HttpCfg {
  return { baseUrl: env.REGISTRY_PROVIDER_BASE_URL || "https://kyc-api.surepass.io", timeoutMs: Number(env.REGISTRY_PROVIDER_TIMEOUT_MS) || 8000, retries: 2, fetchImpl };
}

export function surepassUdyamProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): UdyamProvider {
  const token = env.REGISTRY_PROVIDER_KEY;
  const cfg = cfgFrom(env, fetchImpl);
  return {
    name: "surepass",
    lookup: (udyam) => withCircuitBreaker("surepass-udyam", async () => {
      if (!token) throw new GstnProviderError("auth", "REGISTRY_PROVIDER_KEY is not set");
      const { status, body } = await registryJson(SUREPASS_UDYAM_PATH, token, { id_number: udyam }, cfg);
      return parseSurepassUdyam(status, body, udyam);
    }),
  };
}
export function parseSurepassUdyam(status: number, body: unknown, udyam: string): UdyamRecord | null {
  const b = obj(body);
  if (status === 401 || status === 403) throw new GstnProviderError("auth", "Surepass auth failed");
  if (status === 422 || status === 404 || (status === 200 && b.success === false)) return null;
  if (status !== 200) throw new GstnProviderError("bad_response", `Surepass HTTP ${status}`);
  const d = obj(b.data);
  const main = obj(d.main_details ?? d.enterprise_details ?? d);
  const name = first(main, "name_of_enterprise", "enterprise_name", "name", "business_name");
  if (!name) return null;
  const st = (first(main, "status", "udyam_status") ?? "active").toLowerCase();
  return {
    udyamNumber: first(main, "udyam_number", "udyam_registration_number", "registration_number") ?? udyam,
    enterpriseName: name,
    enterpriseType: first(main, "enterprise_type", "type_of_enterprise")?.toLowerCase(),
    organisationType: first(main, "organization_type", "organisation_type", "type_of_organization")?.toLowerCase(),
    majorActivity: first(main, "major_activity", "activity"),
    incorporationDate: isoDate(first(main, "date_of_incorporation", "incorporation_date")),
    status: st.startsWith("cancel") ? "Cancelled" : st.startsWith("inactive") ? "Inactive" : "Active",
    address: addr(d.official_address, d.address, main.address, d.unit_details),
  };
}

export function surepassMcaProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): McaProvider {
  const token = env.REGISTRY_PROVIDER_KEY;
  const cfg = cfgFrom(env, fetchImpl);
  return {
    name: "surepass",
    lookup: (cin) => withCircuitBreaker("surepass-mca", async () => {
      if (!token) throw new GstnProviderError("auth", "REGISTRY_PROVIDER_KEY is not set");
      const { status, body } = await registryJson(SUREPASS_MCA_PATH, token, { id_number: cin }, cfg);
      return parseSurepassMca(status, body, cin);
    }),
  };
}
const mcaStatus = (v: string | undefined): McaStatus => {
  const s = (v ?? "active").toLowerCase();
  return s.startsWith("active") ? "Active" : /strike|struck/.test(s) ? "Struck Off" : /liquid/.test(s) ? "Under Liquidation" : /amalgam/.test(s) ? "Amalgamated" : "Inactive";
};
export function parseSurepassMca(status: number, body: unknown, cin: string): McaRecord | null {
  const b = obj(body);
  if (status === 401 || status === 403) throw new GstnProviderError("auth", "Surepass auth failed");
  if (status === 422 || status === 404 || (status === 200 && b.success === false)) return null;
  if (status !== 200) throw new GstnProviderError("bad_response", `Surepass HTTP ${status}`);
  const d = obj(b.data);
  const name = first(d, "company_name", "business_name", "name");
  if (!name) return null;
  return {
    cin: first(d, "company_id", "cin") ?? cin,
    companyName: name,
    status: mcaStatus(first(d, "company_status", "status", "company_status_for_efiling")),
    classOfCompany: first(d, "class_of_company", "company_class"),
    incorporationDate: isoDate(first(d, "incorporation_date", "date_of_incorporation")),
    rocCode: first(d, "roc_code", "roc"),
    address: addr(d.registered_address, d.address, d.registered_office_address),
  };
}

// ---------- factories ----------
let udyamOverride: UdyamProvider | null = null;
let mcaOverride: McaProvider | null = null;
export const setUdyamProvider = (p: UdyamProvider | null) => void (udyamOverride = p);
export const setMcaProvider = (p: McaProvider | null) => void (mcaOverride = p);

function pick<T>(kind: "UDYAM" | "MCA", env: NodeJS.ProcessEnv, mock: T, real: () => T): T {
  const name = (env[`${kind}_PROVIDER`] ?? "mock").toLowerCase();
  if (name === "mock") {
    if (env.NODE_ENV === "production") throw new DomainError("validation", `${kind}_PROVIDER=mock is not allowed in production`);
    return mock;
  }
  if (name === "surepass") {
    if (!env.REGISTRY_PROVIDER_KEY) throw new DomainError("validation", `REGISTRY_PROVIDER_KEY is required for ${kind}_PROVIDER=surepass`);
    return real();
  }
  throw new DomainError("validation", `Unknown ${kind}_PROVIDER "${name}" (expected mock | surepass)`);
}
export const getUdyamProvider = (env: NodeJS.ProcessEnv = process.env): UdyamProvider => udyamOverride ?? pick("UDYAM", env, mockUdyamProvider, () => surepassUdyamProvider(env));
export const getMcaProvider = (env: NodeJS.ProcessEnv = process.env): McaProvider => mcaOverride ?? pick("MCA", env, mockMcaProvider, () => surepassMcaProvider(env));
