/** Tiny inline daily-requests chart. Decorative bars + an accessible text summary. */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  const w = 4, gap = 1, h = 24;
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg width={values.length * (w + gap)} height={h} role="img" aria-label={`${label}: ${total} requests in the last ${values.length} days`} className="text-brand-600">
      {values.map((v, i) => {
        const bh = v === 0 ? 1 : Math.max(2, Math.round((v / max) * h));
        return <rect key={i} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={1} fill="currentColor" opacity={v === 0 ? 0.25 : 1} />;
      })}
    </svg>
  );
}
