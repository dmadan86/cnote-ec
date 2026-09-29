const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

/** Renders integer paise as ₹, e.g. <Money paise={199900} unit="piece" /> → "₹1,999 / piece". */
export function Money({ paise, unit, className }: { paise: number | bigint; unit?: string | null; className?: string }) {
  const n = Number(paise);
  const text = n % 100 === 0 ? inr.format(n / 100).replace(/\.00$/, "") : inr.format(n / 100);
  return (
    <span className={className}>
      <span className="font-bold text-ink">{text}</span>
      {unit ? <span className="text-muted"> / {unit}</span> : null}
    </span>
  );
}
