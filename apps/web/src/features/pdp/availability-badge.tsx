// Availability badge. The state is always spelled out in text and carries an icon, never colour alone (WCAG 1.4.1). Presentational
// only (no hooks), so server components (cards) and client islands (PDP) can both render it with a label they already translated.
import { Hourglass, PackageCheck, PackageX } from "lucide-react";
import type { Availability } from "./variants";

const STYLE: Record<Availability, string> = {
  in_stock: "border-green-700 bg-green-50 text-green-900",
  made_to_order: "border-amber-700 bg-amber-50 text-amber-950",
  out_of_stock: "border-red-700 bg-red-50 text-red-900",
};
const ICON = { in_stock: PackageCheck, made_to_order: Hourglass, out_of_stock: PackageX } as const;

export function AvailabilityBadge({ availability, label, size = "md", className = "" }: { availability: Availability; label: string; size?: "sm" | "md"; className?: string }) {
  const Icon = ICON[availability];
  return (
    <span
      data-availability={availability}
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold ${size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"} ${STYLE[availability]} ${className}`}
    >
      <Icon className={size === "sm" ? "size-3.5" : "size-4"} aria-hidden />
      {label}
    </span>
  );
}
