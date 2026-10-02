"use client";
import { useState, type ReactNode } from "react";

/**
 * Wraps the (server-rendered) compare table with a "Highlight differences" switch. Rows that differ carry
 * `group-data-[highlight=true]/cmp:` styles plus a visible "Differs" tag, so the highlight is never colour-only.
 * On by default (the table has always highlighted differing rows).
 */
export function HighlightRegion({ label, children }: { label: string; children: ReactNode }) {
  const [on, setOn] = useState(true);
  return (
    <div className="group/cmp" data-highlight={on ? "true" : "false"}>
      <label className="mb-3 inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-ink">
        <input type="checkbox" role="switch" checked={on} onChange={(e) => setOn(e.target.checked)} className="size-5 accent-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600" />
        {label}
      </label>
      {children}
    </div>
  );
}
