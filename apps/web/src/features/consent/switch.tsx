"use client";

import { cn } from "@cnote/ui";

/**
 * Accessible on/off switch: a real <button role="switch" aria-checked>. The name comes from `labelledBy` (the visible
 * heading), the visible "On"/"Off" text shows the state in words (never colour alone), and the hit area is 44px.
 */
export function Switch({ checked, onChange, labelledBy, describedBy, onLabel, offLabel }: { checked: boolean; onChange: (next: boolean) => void; labelledBy: string; describedBy?: string; onLabel: string; offLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onClick={() => onChange(!checked)}
      className="inline-flex min-h-11 min-w-11 items-center gap-2 rounded-full px-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <span aria-hidden="true" className="min-w-7 text-end text-sm font-semibold text-ink">
        {checked ? onLabel : offLabel}
      </span>
      <span aria-hidden="true" className={cn("relative block h-7 w-12 shrink-0 rounded-full border-2 transition-colors motion-reduce:transition-none", checked ? "border-brand-600 bg-brand-600" : "border-muted bg-surface")}>
        <span className={cn("absolute left-0.5 top-0.5 block size-5 rounded-full transition-transform motion-reduce:transition-none", checked ? "translate-x-[22px] bg-white" : "translate-x-0 bg-muted")} />
      </span>
    </button>
  );
}
