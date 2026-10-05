// Live rate adapters (Shiprocket, Delhivery) behind FREIGHT_PROVIDER. Parcel/courier only: both public rate APIs price courier
// consignments, so part-truck and full-truck lanes (and any failure) fall back to the rate card (reported as `provider_fallback`).
// Outbound calls are SSRF-checked + DNS-pinned (assertPublicHttpTarget + pinnedFetch), time-boxed, and cached in Redis.
// Docs: Shiprocket GET /v1/external/courier/serviceability (Bearer token from POST /auth/login);
//       Delhivery GET /api/kinko/v1/invoice/charges/.json (Authorization: Token <api token>).
import { cached, redis } from "@cnote/core";
import { assertPublicHttpTarget, pinnedFetch } from "@cnote/security";
import { DEFAULT_RATE_CARD, type RateCard } from "./card";
import { estimateWithCard } from "./heuristic";
import { classifyLane } from "./zones";
import type { FreightEstimate, FreightRateProvider, FreightRequest } from "./types";

/** Injectable HTTP (tests pass a stub; production uses the pinned fetch). */
export type HttpJson = (url: string, init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; timeoutMs: number }) => Promise<{ status: number; json: unknown }>;

export const pinnedHttpJson: HttpJson = async (url, init) => {
  const target = await assertPublicHttpTarget(url);
  const res = await pinnedFetch(target, { method: init.method, headers: init.headers, body: init.body, timeoutMs: init.timeoutMs });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

const TIMEOUT_MS = 4000;
const CACHE_SECONDS = 6 * 3600;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const asRec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const rupeesToPaise = (r: number): number => Math.round(r * 100);

export interface AdapterDeps {
  http?: HttpJson;
  /** card used for GST/fuel/spread/weights and the fallback shape */
  loadCard?: () => Promise<RateCard> | RateCard;
  /** cache override (tests run without Redis latency concerns but keep the same path) */
  cache?: <T>(key: string, ttl: number, load: () => Promise<T>) => Promise<T>;
}

function withRates(base: FreightEstimate, lowFreight: number, highFreight: number, days: { min: number; max: number } | null, providerId: string): FreightEstimate {
  const gst = (n: number) => Math.round((n * base.gstRateBps) / 10_000);
  const mid = Math.round((lowFreight + highFreight) / 2);
  return {
    ...base,
    provider: providerId,
    mode: "parcel",
    vehicles: 1,
    lowPaise: lowFreight,
    highPaise: highFreight,
    midPaise: mid,
    gstLowPaise: gst(lowFreight),
    gstHighPaise: gst(highFreight),
    transitDays: days ?? base.transitDays,
    assumptions: base.assumptions.filter((a) => a !== "multi_vehicle"),
  };
}

/** Shared flow: price the shipment with the card to learn mode/weights, then ask the live API only for parcel lanes. */
async function liveOrFallback(
  id: string, req: FreightRequest, deps: AdapterDeps,
  fetchRates: (kg: number, req: FreightRequest) => Promise<{ low: number; high: number; days: { min: number; max: number } | null } | null>,
): Promise<FreightEstimate> {
  const card = deps.loadCard ? await deps.loadCard() : DEFAULT_RATE_CARD;
  const base = estimateWithCard(req, card, id);
  const fallback = (): FreightEstimate => ({ ...base, provider: "heuristic", assumptions: [...base.assumptions, "provider_fallback"] });
  const lane = classifyLane(req.originPincode, req.destinationPincode);
  if (base.mode !== "parcel" || !req.originPincode || !lane.originKnown || !lane.destinationKnown) return fallback();
  const kg = Math.max(0.5, base.chargeableWeightKg);
  const key = `logistics:${id}:${req.originPincode}:${req.destinationPincode}:${Math.ceil(kg * 2) / 2}`;
  const run = deps.cache ?? cached;
  try {
    const r = await run(key, CACHE_SECONDS, async () => {
      const got = await fetchRates(kg, req);
      if (!got) throw new Error("no rate");
      return got;
    });
    return withRates(base, r.low, r.high, r.days, id);
  } catch {
    return fallback();
  }
}

// ---------------------------------------------------------------------------------------------------------------- Shiprocket

export interface ShiprocketConfig { baseUrl: string; email: string; password: string }

export function shiprocketConfig(env: NodeJS.ProcessEnv = process.env): ShiprocketConfig | null {
  const email = env.SHIPROCKET_EMAIL?.trim();
  const password = env.SHIPROCKET_PASSWORD;
  if (!email || !password) return null;
  return { baseUrl: (env.SHIPROCKET_BASE_URL?.trim() || "https://apiv2.shiprocket.in/v1/external").replace(/\/$/, ""), email, password };
}

/** Pure mapping of the serviceability response: cheapest and dearest serviceable courier freight (ex-GST, paise) and the delivery-day span. */
export function parseShiprocket(json: unknown): { low: number; high: number; days: { min: number; max: number } | null } | null {
  const list = asRec(asRec(json).data).available_courier_companies;
  if (!Array.isArray(list)) return null;
  const rates: number[] = [];
  const days: number[] = [];
  for (const c of list) {
    const r = asRec(c);
    const freight = num(r.freight_charge) ?? num(r.rate);
    if (freight !== null && freight > 0) rates.push(rupeesToPaise(freight));
    const d = num(r.estimated_delivery_days);
    if (d !== null && d > 0) days.push(Math.ceil(d));
  }
  if (!rates.length) return null;
  return { low: Math.min(...rates), high: Math.max(...rates), days: days.length ? { min: Math.min(...days), max: Math.max(...days) } : null };
}

export function shiprocketProvider(cfg: ShiprocketConfig, deps: AdapterDeps = {}): FreightRateProvider {
  const http = deps.http ?? pinnedHttpJson;
  const token = async (): Promise<string> =>
    (deps.cache ?? cached)(`logistics:shiprocket:token:${cfg.email}`, 8 * 24 * 3600, async () => {
      const res = await http(`${cfg.baseUrl}/auth/login`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ email: cfg.email, password: cfg.password }), timeoutMs: TIMEOUT_MS });
      const t = asRec(res.json).token;
      if (res.status !== 200 || typeof t !== "string") throw new Error("shiprocket auth failed");
      return t;
    });
  return {
    id: "shiprocket",
    estimate: (req) => liveOrFallback("shiprocket", req, deps, async (kg, r) => {
      const qs = new URLSearchParams({ pickup_postcode: r.originPincode!, delivery_postcode: r.destinationPincode, weight: String(kg), cod: "0" });
      let res = await http(`${cfg.baseUrl}/courier/serviceability/?${qs}`, { method: "GET", headers: { authorization: `Bearer ${await token()}`, accept: "application/json" }, timeoutMs: TIMEOUT_MS });
      if (res.status === 401) {
        await redis.del(`logistics:shiprocket:token:${cfg.email}`).catch(() => undefined);
        res = await http(`${cfg.baseUrl}/courier/serviceability/?${qs}`, { method: "GET", headers: { authorization: `Bearer ${await token()}`, accept: "application/json" }, timeoutMs: TIMEOUT_MS });
      }
      return res.status === 200 ? parseShiprocket(res.json) : null;
    }),
  };
}

// ---------------------------------------------------------------------------------------------------------------- Delhivery

export interface DelhiveryConfig { baseUrl: string; token: string; clientName: string | null }

export function delhiveryConfig(env: NodeJS.ProcessEnv = process.env): DelhiveryConfig | null {
  const token = env.DELHIVERY_API_TOKEN?.trim();
  if (!token) return null;
  return { baseUrl: (env.DELHIVERY_BASE_URL?.trim() || "https://track.delhivery.com").replace(/\/$/, ""), token, clientName: env.DELHIVERY_CLIENT_NAME?.trim() || null };
}

/** Delhivery returns an array with one charge object: `total_amount` (with tax) and `gross_amount` (before tax), in rupees. */
export function parseDelhivery(json: unknown): { low: number; high: number; days: null } | null {
  const first = asRec(Array.isArray(json) ? json[0] : json);
  const gross = num(first.gross_amount) ?? num(first.charge_DL) ?? null;
  const total = num(first.total_amount);
  const freight = gross ?? (total !== null ? total / 1.18 : null);
  if (freight === null || freight <= 0) return null;
  const p = rupeesToPaise(freight);
  return { low: p, high: p, days: null };
}

export function delhiveryProvider(cfg: DelhiveryConfig, deps: AdapterDeps = {}): FreightRateProvider {
  const http = deps.http ?? pinnedHttpJson;
  return {
    id: "delhivery",
    estimate: (req) => liveOrFallback("delhivery", req, deps, async (kg, r) => {
      const qs = new URLSearchParams({ md: "S", ss: "Delivered", d_pin: r.destinationPincode, o_pin: r.originPincode!, cgm: String(Math.ceil(kg * 1000)), pt: "Pre-paid" });
      if (cfg.clientName) qs.set("cl", cfg.clientName);
      const res = await http(`${cfg.baseUrl}/api/kinko/v1/invoice/charges/.json?${qs}`, { method: "GET", headers: { authorization: `Token ${cfg.token}`, accept: "application/json" }, timeoutMs: TIMEOUT_MS });
      const parsed = res.status === 200 ? parseDelhivery(res.json) : null;
      if (!parsed) return null;
      // a single quoted price: widen into the card's low/high spread so the buyer still sees a range (the carrier's own slabs vary by lane and surcharge)
      return { low: Math.round(parsed.low * 0.95), high: Math.round(parsed.high * 1.2), days: null };
    }),
  };
}

