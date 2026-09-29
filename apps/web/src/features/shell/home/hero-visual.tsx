/** Warehouse backdrop for the hero (pure SVG, no external images). Decorative only. */
export function HeroVisual({ className }: { className?: string }) {
  const boxes: [number, number, number, number, string][] = [
    [40, 330, 90, 70, "#d9ad72"], [130, 350, 80, 50, "#c99a5e"], [60, 270, 70, 60, "#e3bb85"], [230, 320, 100, 80, "#d9ad72"],
    [350, 340, 90, 60, "#c99a5e"], [370, 280, 70, 60, "#e3bb85"], [470, 300, 110, 100, "#d9ad72"], [600, 330, 90, 70, "#c99a5e"],
    [620, 260, 80, 70, "#e3bb85"], [720, 310, 100, 90, "#d9ad72"],
  ];
  return (
    <svg viewBox="0 0 840 420" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient id="hv-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dbeafe" />
          <stop offset="1" stopColor="#f5efe6" />
        </linearGradient>
        <linearGradient id="hv-floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e7dfd3" />
          <stop offset="1" stopColor="#cfc5b5" />
        </linearGradient>
        <linearGradient id="hv-light" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="840" height="420" fill="url(#hv-sky)" />
      {/* skylight windows */}
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <g key={i}>
          <rect x={60 + i * 125} y="20" width="105" height="120" fill="#bfdbfe" opacity=".75" />
          <path d={`M${60 + i * 125} 80h105M${112 + i * 125} 20v120`} stroke="#fff" strokeWidth="4" opacity=".8" />
        </g>
      ))}
      <polygon points="120,0 300,0 180,240 0,240" fill="url(#hv-light)" opacity=".7" />
      {/* racking */}
      {[0, 1].map((r) => (
        <g key={r} stroke="#64748b" strokeWidth="6" opacity=".85">
          <path d={`M${420 + r * 200} 150v250M${520 + r * 200} 150v250M${420 + r * 200} 240h100M${420 + r * 200} 320h100`} />
        </g>
      ))}
      {[0, 1, 2].map((i) => (
        <rect key={i} x={430 + i * 30} y={190} width="26" height="46" fill="#d9ad72" opacity=".9" />
      ))}
      <rect x="0" y="300" width="840" height="120" fill="url(#hv-floor)" />
      {boxes.map(([x, y, w, h, c], i) => (
        <g key={i}>
          <rect x={x} y={y} width={w} height={h} fill={c} rx="3" />
          <path d={`M${x} ${y + h * 0.3}h${w}`} stroke="#00000018" strokeWidth="3" />
          <rect x={x + w * 0.35} y={y} width={w * 0.3} height="8" fill="#ffffff55" />
        </g>
      ))}
      {/* forklift */}
      <g transform="translate(560 250)">
        <rect x="40" y="40" width="70" height="50" rx="6" fill="#f59e0b" />
        <rect x="46" y="10" width="46" height="40" fill="none" stroke="#374151" strokeWidth="6" />
        <rect x="0" y="0" width="8" height="120" fill="#4b5563" />
        <rect x="0" y="90" width="50" height="8" fill="#4b5563" />
        <circle cx="62" cy="96" r="14" fill="#1f2937" />
        <circle cx="104" cy="96" r="12" fill="#1f2937" />
      </g>
    </svg>
  );
}
