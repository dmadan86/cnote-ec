const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const GSTIN_RE = /^(0[1-9]|[12][0-9]|3[0-8])([A-Z]{5}[0-9]{4}[A-Z])([1-9A-Z])Z([0-9A-Z])$/;
const UDYAM_RE = /^UDYAM-[A-Z]{2}-\d{2}-\d{7}$/;

export const GST_STATES: Record<string, string> = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana",
  "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh",
  "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam", "19": "West Bengal",
  "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra", "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
};

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARSET.indexOf(first14[i]!);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / CHARSET.length) + (p % CHARSET.length);
  }
  return CHARSET[(CHARSET.length - (sum % CHARSET.length)) % CHARSET.length]!;
}

/** Structure (state code 01–38, PAN pattern, 'Z') + base-36 mod checksum. */
export function isValidGstin(gstin: string): boolean {
  return GSTIN_RE.test(gstin) && gstinCheckChar(gstin.slice(0, 14)) === gstin[14];
}
export function isValidUdyam(udyam: string): boolean {
  return UDYAM_RE.test(udyam);
}
export const normaliseGstin = (g: string) => g.trim().toUpperCase();

export type GstnStatus = "Active" | "Cancelled" | "Suspended" | "Inactive";

/** One GSTR-3B (monthly) filing period as reported by the provider. `period` is "YYYY-MM". */
export interface GstnFiling {
  period: string;
  filed: boolean;
  filedOn?: string;
}

/** Normalised taxpayer record. Provider adapters map their vendor payloads onto this. */
export interface GstnRecord {
  legalName: string;
  tradeName?: string;
  /** state name derived from the GSTIN state code (or the provider's) */
  state: string | null;
  status: GstnStatus;
  /** ISO date (YYYY-MM-DD) */
  registrationDate?: string;
  /** Regular | Composition | ... (as reported) */
  taxpayerType?: string;
  /** e.g. "Private Limited Company" */
  constitution?: string;
  stateJurisdiction?: string;
  principalAddress?: { line?: string; city?: string; state?: string; pincode?: string };
  /** GSTR-3B history, newest first, when the provider returns it */
  filings?: GstnFiling[];
  /** HSN codes declared on the GST registration, when returned */
  hsnCodes?: string[];
}

export interface GstnLookupOptions {
  /** name to match at the provider (Cashfree accepts one); the mock echoes it */
  businessName?: string;
}

/** Thrown by adapters for infrastructure failures (as opposed to "GSTIN not found", which is `null`). */
export class GstnProviderError extends Error {
  constructor(
    public readonly kind: "timeout" | "unavailable" | "rate_limited" | "auth" | "bad_response" | "circuit_open",
    message: string,
  ) {
    super(message);
    this.name = "GstnProviderError";
  }
}

/** Swap for a real GSP/KYC vendor client without touching callers. `null` = GSTIN not found. */
export interface GstnProvider {
  name: string;
  lookup(gstin: string, opts?: GstnLookupOptions): Promise<GstnRecord | null>;
}

/** Legacy deterministic dev provider (kept for callers importing it): any structurally valid GSTIN is "Active". */
export const mockGstnProvider: GstnProvider = {
  name: "mock",
  async lookup(gstin) {
    const pan = gstin.slice(2, 12);
    return { legalName: `${pan} Enterprises Pvt Ltd`, tradeName: `${pan} Traders`, state: GST_STATES[gstin.slice(0, 2)] ?? null, status: "Active" };
  },
};

let provider: GstnProvider | null = null;
let defaultFactory: (() => GstnProvider) | null = null;
/** Registered by gst/ at load: builds the env-selected provider (GST_PROVIDER) lazily. */
export const setDefaultGstnProviderFactory = (f: () => GstnProvider) => void (defaultFactory = f);
export const getGstnProvider = (): GstnProvider => {
  if (provider) return provider;
  provider = defaultFactory ? defaultFactory() : mockGstnProvider;
  return provider;
};
export const setGstnProvider = (p: GstnProvider | null) => void (provider = p);
