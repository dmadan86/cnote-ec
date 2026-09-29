// GSTN provider adapters (ADR-003 T1). There is no open public GSTN API: production goes through a
// GSP / KYC vendor. Selected by env: GST_PROVIDER = mock (default) | cashfree | surepass.
//   GST_PROVIDER_KEY (Cashfree client id / Surepass bearer token), GST_PROVIDER_SECRET (Cashfree client secret),
//   GST_PROVIDER_BASE_URL (override; defaults to the vendor production URL), GST_PROVIDER_TIMEOUT_MS (default 8000).
import { redis } from "@cnote/core";
import {
  GST_STATES, GstnProviderError, setDefaultGstnProviderFactory,
  type GstnFiling, type GstnLookupOptions, type GstnProvider, type GstnRecord, type GstnStatus,
} from "../gstin";

// ---------- mock ----------
/**
 * Deterministic dev/CI provider. Behaviour keys off the 13th GSTIN character (entity registration no.):
 *   C cancelled · S suspended · M legal name mismatch · N not found · U provider unavailable · F poor filing history
 *   anything else: Active. The legal name echoes `opts.businessName` when given (so dev onboarding passes the name check).
 * Tests can pin exact records with `setFixture`.
 */
export interface MockGstnProvider extends GstnProvider {
  setFixture(gstin: string, record: GstnRecord | null): void;
  clearFixtures(): void;
}
export function createMockGstnProvider(): MockGstnProvider {
  const fixtures = new Map<string, GstnRecord | null>();
  return {
    name: "mock",
    setFixture: (g, r) => void fixtures.set(g, r),
    clearFixtures: () => fixtures.clear(),
    async lookup(gstin, opts) {
      if (fixtures.has(gstin)) return fixtures.get(gstin) ?? null;
      const code = gstin[12]!;
      if (code === "N") return null;
      if (code === "U") throw new GstnProviderError("unavailable", "mock provider unavailable");
      const pan = gstin.slice(2, 12);
      const state = GST_STATES[gstin.slice(0, 2)] ?? null;
      const now = new Date();
      const filings: GstnFiling[] = Array.from({ length: 6 }, (_, i) => {
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1 - i, 1));
        return { period: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`, filed: code === "F" ? i > 3 : true };
      });
      return {
        legalName: code === "M" ? "Completely Different Traders Private Limited" : (opts?.businessName?.trim() || `${pan} Enterprises Pvt Ltd`),
        tradeName: code === "M" ? "Different Traders" : opts?.businessName?.trim() || `${pan} Traders`,
        state,
        status: code === "C" ? "Cancelled" : code === "S" ? "Suspended" : "Active",
        registrationDate: "2019-04-01",
        taxpayerType: "Regular",
        constitution: "Private Limited Company",
        principalAddress: { state: state ?? undefined },
        filings,
      };
    },
  };
}
export const mockProvider = createMockGstnProvider();

// ---------- circuit breaker (Redis; shared across worker + web instances) ----------
const CB_FAIL_THRESHOLD = 5;
const CB_WINDOW_S = 60;
const CB_OPEN_S = 60;
export async function withCircuitBreaker<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const openKey = `gstn:cb:${name}:open`;
  const failKey = `gstn:cb:${name}:fails`;
  try {
    if (await redis.exists(openKey)) throw new GstnProviderError("circuit_open", `${name} circuit is open; retry shortly`);
  } catch (e) {
    if (e instanceof GstnProviderError) throw e; // Redis being down must not block verification
  }
  try {
    const out = await fn();
    await redis.del(failKey).catch(() => undefined);
    return out;
  } catch (err) {
    // only infrastructure failures count; auth misconfig and 4xx are ours to fix, not a vendor outage
    if (err instanceof GstnProviderError && ["timeout", "unavailable", "bad_response"].includes(err.kind)) {
      try {
        const n = await redis.incr(failKey);
        if (n === 1) await redis.expire(failKey, CB_WINDOW_S);
        if (n >= CB_FAIL_THRESHOLD) await redis.set(openKey, "1", "EX", CB_OPEN_S);
      } catch { /* best effort */ }
    }
    throw err;
  }
}

// ---------- shared HTTP ----------
interface HttpCfg { baseUrl: string; timeoutMs: number; retries: number }
async function httpJson(url: string, init: RequestInit, cfg: HttpCfg): Promise<{ status: number; body: unknown }> {
  let last: unknown;
  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      if (res.status >= 500) throw new GstnProviderError("unavailable", `provider HTTP ${res.status}`);
      if (res.status === 429) throw new GstnProviderError("rate_limited", "provider rate limit exceeded");
      const text = await res.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { throw new GstnProviderError("bad_response", "provider returned non-JSON"); }
      return { status: res.status, body };
    } catch (err) {
      last = (err as { name?: string })?.name === "AbortError" ? new GstnProviderError("timeout", `provider timed out after ${cfg.timeoutMs}ms`) : err;
      const retryable = last instanceof GstnProviderError ? last.kind === "timeout" || last.kind === "unavailable" : true;
      if (!retryable || attempt === cfg.retries) break;
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt + Math.floor(Math.random() * 100)));
    } finally {
      clearTimeout(t);
    }
  }
  throw last instanceof GstnProviderError ? last : new GstnProviderError("unavailable", `provider request failed: ${(last as Error)?.message ?? last}`);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
function mapStatus(v: unknown): GstnStatus {
  const s = String(v ?? "").toLowerCase();
  if (s.startsWith("active")) return "Active";
  if (s.startsWith("cancel")) return "Cancelled";
  if (s.startsWith("suspend")) return "Suspended";
  return "Inactive";
}
const isoDate = (v: unknown): string | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/) ?? s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/);
  if (!m) return undefined;
  return m[1]!.length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
};

// ---------- Cashfree Verification Suite ----------
/** POST {base}/verification/gstin  (headers x-client-id / x-client-secret). Priced per successful call. */
export function cashfreeProvider(env: NodeJS.ProcessEnv = process.env): GstnProvider {
  const id = env.GST_PROVIDER_KEY, secret = env.GST_PROVIDER_SECRET;
  const cfg: HttpCfg = { baseUrl: env.GST_PROVIDER_BASE_URL || "https://api.cashfree.com", timeoutMs: Number(env.GST_PROVIDER_TIMEOUT_MS) || 8000, retries: 2 };
  return {
    name: "cashfree",
    lookup: (gstin, opts) =>
      withCircuitBreaker("cashfree", async () => {
        if (!id || !secret) throw new GstnProviderError("auth", "GST_PROVIDER_KEY / GST_PROVIDER_SECRET are not set");
        const { status, body } = await httpJson(
          `${cfg.baseUrl}/verification/gstin`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-client-id": id, "x-client-secret": secret },
            body: JSON.stringify({ GSTIN: gstin, ...(opts?.businessName ? { business_name: opts.businessName.slice(0, 200) } : {}) }),
          },
          cfg,
        );
        return parseCashfree(status, body, gstin);
      }),
  };
}
export function parseCashfree(status: number, body: unknown, gstin: string): GstnRecord | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 401 || status === 403) throw new GstnProviderError("auth", `Cashfree auth failed (${str(b.code) ?? status})`);
  if (status === 422 && b.code === "insufficient_balance") throw new GstnProviderError("auth", "Cashfree balance exhausted");
  if (status === 400 || status === 404 || (status === 200 && b.valid === false)) return null;
  if (status !== 200) throw new GstnProviderError("bad_response", `Cashfree HTTP ${status}`);
  const split = (b.principal_place_split_address ?? {}) as Record<string, unknown>;
  return {
    legalName: str(b.legal_name_of_business) ?? "",
    tradeName: str(b.trade_name_of_business),
    state: GST_STATES[gstin.slice(0, 2)] ?? null,
    status: mapStatus(b.gst_in_status),
    registrationDate: isoDate(b.date_of_registration),
    taxpayerType: str(b.taxpayer_type),
    constitution: str(b.constitution_of_business),
    stateJurisdiction: str(b.state_jurisdiction),
    principalAddress: { line: str(b.principal_place_address), city: str(split.city) ?? str(split.district), state: str(split.state), pincode: str(split.pincode) },
  };
}

// ---------- Surepass ----------
/**
 * POST {base}/api/v1/corporate/gstin  { id_number }  Authorization: Bearer <token>.  Filing history (GSTR-3B) comes from a
 * separate paid "GST return status" endpoint; enabled with GST_PROVIDER_FILINGS=1 (best effort, failures ignored).
 * Field names follow Surepass' documented `data` object; confirm against your account's docs (see docs/design/gst-verification.md).
 */
export function surepassProvider(env: NodeJS.ProcessEnv = process.env): GstnProvider {
  const token = env.GST_PROVIDER_KEY;
  const cfg: HttpCfg = { baseUrl: env.GST_PROVIDER_BASE_URL || "https://kyc-api.surepass.io", timeoutMs: Number(env.GST_PROVIDER_TIMEOUT_MS) || 8000, retries: 2 };
  const headers = () => ({ "content-type": "application/json", authorization: `Bearer ${token}` });
  return {
    name: "surepass",
    lookup: (gstin: string, _opts?: GstnLookupOptions) =>
      withCircuitBreaker("surepass", async () => {
        if (!token) throw new GstnProviderError("auth", "GST_PROVIDER_KEY is not set");
        const { status, body } = await httpJson(`${cfg.baseUrl}/api/v1/corporate/gstin`, { method: "POST", headers: headers(), body: JSON.stringify({ id_number: gstin }) }, cfg);
        const rec = parseSurepass(status, body, gstin);
        if (rec && env.GST_PROVIDER_FILINGS === "1") {
          try {
            const r = await httpJson(`${cfg.baseUrl}/api/v1/corporate/gst-return-status`, { method: "POST", headers: headers(), body: JSON.stringify({ gstin, financial_year: currentFy() }) }, cfg);
            rec.filings = parseSurepassFilings(r.body);
          } catch { /* filing regularity is optional evidence */ }
        }
        return rec;
      }),
  };
}
const currentFy = () => {
  const d = new Date();
  const y = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String(y + 1).slice(2)}`;
};
export function parseSurepass(status: number, body: unknown, gstin: string): GstnRecord | null {
  const b = (body ?? {}) as Record<string, unknown>;
  if (status === 401 || status === 403) throw new GstnProviderError("auth", "Surepass auth failed");
  if (status === 422 || status === 404 || (status === 200 && b.success === false)) return null;
  if (status !== 200) throw new GstnProviderError("bad_response", `Surepass HTTP ${status}`);
  const d = (b.data ?? {}) as Record<string, unknown>;
  const addr = (d.address_details ?? d.principal_address ?? {}) as Record<string, unknown>;
  return {
    legalName: str(d.legal_name) ?? str(d.business_name) ?? "",
    tradeName: str(d.business_name) ?? str(d.trade_name),
    state: GST_STATES[gstin.slice(0, 2)] ?? null,
    status: mapStatus(d.gstin_status ?? d.status),
    registrationDate: isoDate(d.date_of_registration),
    taxpayerType: str(d.taxpayer_type),
    constitution: str(d.constitution_of_business) ?? str(d.constitutional_of_business),
    stateJurisdiction: str(d.state_jurisdiction),
    principalAddress: { line: str(d.address) ?? str(addr.address), city: str(addr.city) ?? str(addr.district), state: str(addr.state), pincode: str(addr.pincode) },
    hsnCodes: Array.isArray(d.hsn_info) ? (d.hsn_info as unknown[]).map((h) => str((h as Record<string, unknown>)?.hsn_no ?? h)).filter((x): x is string => !!x) : undefined,
  };
}
export function parseSurepassFilings(body: unknown): GstnFiling[] | undefined {
  const rows = ((body as { data?: { filing_status?: unknown[][] | unknown[] } })?.data?.filing_status ?? []).flat() as Record<string, unknown>[];
  const out: GstnFiling[] = [];
  for (const r of rows) {
    if (String(r.return_type ?? r.rtype ?? "").toUpperCase() !== "GSTR3B") continue;
    const ret = String(r.return_period ?? r.ret_prd ?? ""); // MMYYYY
    if (!/^\d{6}$/.test(ret)) continue;
    const st = String(r.status ?? "").toLowerCase();
    out.push({ period: `${ret.slice(2)}-${ret.slice(0, 2)}`, filed: st === "filed", filedOn: isoDate(r.date_of_filing ?? r.dof) });
  }
  return out.length ? out.sort((a, b) => b.period.localeCompare(a.period)) : undefined;
}

// ---------- factory ----------
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env): GstnProvider {
  switch ((env.GST_PROVIDER ?? "mock").toLowerCase()) {
    case "cashfree": return cashfreeProvider(env);
    case "surepass": return surepassProvider(env);
    case "mock": return mockProvider;
    default: throw new Error(`Unknown GST_PROVIDER "${env.GST_PROVIDER}" (expected mock | cashfree | surepass)`);
  }
}
setDefaultGstnProviderFactory(() => providerFromEnv());
