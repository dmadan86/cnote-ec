import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "@cnote/core";

export const enc = (raw: Uint8Array | string): Buffer => (typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw));

export function header(h: Headers | Record<string, string | undefined>, name: string): string | undefined {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name) ?? undefined;
  const rec = h as Record<string, string | undefined>;
  const k = Object.keys(rec).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? rec[k] : undefined;
}

export const hmac = (secret: string, data: Buffer | string, encoding: "hex" | "base64"): string => createHmac("sha256", secret).update(data).digest(encoding);

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseJson(raw: Uint8Array | string): Record<string, unknown> {
  try {
    const v = JSON.parse(enc(raw).toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* fallthrough */ }
  throw new DomainError("validation", "Malformed webhook body");
}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const REDACT = /^(card|vpa|upi|email|contact|phone|bank|account_number|customer_details|customer|payer_account_number|acquirer_data|beneficiary)$/i;
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).filter(([k]) => !REDACT.test(k)).map(([k, x]) => [k, redact(x)]));
  return v;
}
