// All money is integer paise (ADR-007). Never use floats for amounts.

export type Paise = number;

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

export function paiseToNumber(p: bigint | number | null | undefined): Paise | null {
  return p === null || p === undefined ? null : Number(p);
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

/** ₹1,999 / ₹5.20 — drops ".00" for whole rupees. */
export function formatINR(p: bigint | number): string {
  const n = Number(p);
  const s = inr.format(n / 100);
  return n % 100 === 0 ? s.replace(/\.00$/, "") : s;
}
