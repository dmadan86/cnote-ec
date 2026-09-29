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

export interface GstnRecord {
  legalName: string;
  tradeName?: string;
  state: string | null;
  status: "Active" | "Cancelled" | "Suspended";
}
/** Swap for a real GSP client (GSTN public API) without touching callers. */
export interface GstnProvider {
  name: string;
  lookup(gstin: string): Promise<GstnRecord | null>;
}

/** Deterministic dev provider: any structurally valid GSTIN is "Active". */
export const mockGstnProvider: GstnProvider = {
  name: "mock",
  async lookup(gstin) {
    const pan = gstin.slice(2, 12);
    return { legalName: `${pan} Enterprises Pvt Ltd`, tradeName: `${pan} Traders`, state: GST_STATES[gstin.slice(0, 2)] ?? null, status: "Active" };
  },
};

let provider: GstnProvider = mockGstnProvider;
export const getGstnProvider = () => provider;
export const setGstnProvider = (p: GstnProvider) => void (provider = p);
