import { cn } from "../cn";

const palette = ["bg-brand-100 text-brand-700", "bg-accent-100 text-accent-800", "bg-green-100 text-green-700", "bg-sky-100 text-sky-700", "bg-rose-100 text-rose-700", "bg-amber-100 text-amber-700"];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** Initials avatar; colour is derived from the name so it is stable across renders. */
export function Avatar({ name, size = "md", className }: { name: string; size?: "sm" | "md" | "lg"; className?: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold",
        size === "sm" ? "size-8 text-xs" : size === "lg" ? "size-14 text-lg" : "size-10 text-sm",
        palette[hash(name) % palette.length],
        className,
      )}
    >
      {initials || "?"}
    </span>
  );
}

/** Brand mark (hexagon + box). Pure SVG so it inherits `currentColor`. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8 text-brand-600", className)} aria-hidden fill="none">
      <path d="M16 2.5 27.5 9v14L16 29.5 4.5 23V9L16 2.5Z" fill="currentColor" />
      <path d="M16 9.5 22 13v6.5L16 23l-6-3.5V13l6-3.5Z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M10 13l6 3.5L22 13M16 16.5V23" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  );
}
