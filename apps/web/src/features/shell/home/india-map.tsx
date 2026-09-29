/** Stylised India outline with cluster pins. Decorative; the panel text carries the meaning. */
export function IndiaMap({ className }: { className?: string }) {
  const pins: [number, number][] = [[60, 122], [86, 66], [108, 192], [158, 112], [50, 95]];
  return (
    <svg viewBox="0 0 210 225" className={className} aria-hidden focusable="false">
      <path
        d="M85 5l15 7 12-4 8 12-2 12 10 6 12 7 12 5 10-3 7 6 10 2 6 8-8 6-10-2-4 8 9 4-7 8-8-4-10 7-5 10 3 13-8 10-8 12-7 15-6 15-10 15-7 12-7 12-7-12-10-20-8-20-8-20-10-20-10-15-7-15-15-5-13-5 7-10 13-2 4-10 4-10-7-10 10-10 10-13 7-15 13-25Z"
        fill="#c7d2fe"
        stroke="#818cf8"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {pins.map(([x, y], i) => (
        <g key={i} transform={`translate(${x} ${y})`}>
          <circle r="9" fill="#6d3ff0" opacity=".18" />
          <path d="M0 0c-6-8-8-11-8-15a8 8 0 0 1 16 0c0 4-2 7-8 15Z" fill="#6d3ff0" transform="translate(0 4)" />
          <circle cy="-8" r="3" fill="#fff" />
        </g>
      ))}
    </svg>
  );
}
