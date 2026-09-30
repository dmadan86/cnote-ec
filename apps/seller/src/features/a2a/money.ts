/** Rupee text -> integer paise by string arithmetic (no float drift). Accepts "1,234", "1234.5", "1234.50". Null when not a positive amount. */
export function rupeesToPaiseExact(input: string): number | null {
  const s = input.trim().replace(/,/g, "");
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const paise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

/** Integer paise -> plain rupee text for an input default ("1250" or "1250.5"), exact. */
export function paiseToRupeeText(paise: number | null | undefined): string {
  if (paise == null) return "";
  const r = Math.floor(paise / 100), p = paise % 100;
  return p === 0 ? String(r) : `${r}.${String(p).padStart(2, "0").replace(/0$/, "")}`;
}
