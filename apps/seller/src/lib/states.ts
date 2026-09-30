// Indian states / union territories. `name` is the English value that is STORED (identity.GST_STATES names, plus "Other");
// the label users see comes from the `states` message namespace, keyed by `code` (GST state code), in all 8 locales (ADR-004).
export const STATE_TABLE = [
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "18", name: "Assam" },
  { code: "10", name: "Bihar" },
  { code: "04", name: "Chandigarh" },
  { code: "22", name: "Chhattisgarh" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "07", name: "Delhi" },
  { code: "30", name: "Goa" },
  { code: "24", name: "Gujarat" },
  { code: "06", name: "Haryana" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "01", name: "Jammu and Kashmir" },
  { code: "20", name: "Jharkhand" },
  { code: "29", name: "Karnataka" },
  { code: "32", name: "Kerala" },
  { code: "38", name: "Ladakh" },
  { code: "31", name: "Lakshadweep" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "27", name: "Maharashtra" },
  { code: "14", name: "Manipur" },
  { code: "17", name: "Meghalaya" },
  { code: "15", name: "Mizoram" },
  { code: "13", name: "Nagaland" },
  { code: "21", name: "Odisha" },
  { code: "34", name: "Puducherry" },
  { code: "03", name: "Punjab" },
  { code: "08", name: "Rajasthan" },
  { code: "11", name: "Sikkim" },
  { code: "33", name: "Tamil Nadu" },
  { code: "36", name: "Telangana" },
  { code: "16", name: "Tripura" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "05", name: "Uttarakhand" },
  { code: "19", name: "West Bengal" },
  { code: "other", name: "Other" },
] as const;

export type StateCode = (typeof STATE_TABLE)[number]["code"];

/** English names as stored on Business.state (alphabetical, "Other" last). */
export const STATE_NAMES = STATE_TABLE.map((s) => s.name) as readonly string[];

const BY_NAME = new Map<string, string>(STATE_TABLE.map((s) => [s.name.toLowerCase(), s.code]));
const BY_CODE = new Map<string, string>(STATE_TABLE.map((s) => [s.code, s.name]));

/** Message key (`states.<code>`) for a stored English state name, or a GST code; undefined for unknown/free text. */
export const stateKey = (nameOrCode: string): string | undefined => BY_NAME.get(nameOrCode.trim().toLowerCase()) ?? (BY_CODE.has(nameOrCode) ? nameOrCode : undefined);

/**
 * Display label for a stored state value. `translate(code)` returns the translated label or undefined; anything unknown
 * (legacy free text, a provider's spelling) is shown as stored.
 */
export function stateLabel(nameOrCode: string | null | undefined, translate: (code: string) => string | undefined): string {
  if (!nameOrCode) return "";
  const key = stateKey(nameOrCode);
  return (key ? translate(key) : undefined) ?? BY_CODE.get(nameOrCode) ?? nameOrCode;
}
