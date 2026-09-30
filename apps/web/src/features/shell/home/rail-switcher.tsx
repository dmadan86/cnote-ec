"use client";
import { useTranslations } from "next-intl";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@cnote/ui";

export const RAILS = [
  { id: "business", panel: "popular" },
  { id: "trending", panel: "trending" },
  { id: "new", panel: "new" },
  { id: "best", panel: "popular" },
] as const;
export type RailId = (typeof RAILS)[number]["id"];
export type PanelId = (typeof RAILS)[number]["panel"];

/**
 * ARIA tabs over server-rendered rails. All panels are in the static HTML (hidden ones use `hidden`, so crawlers
 * and LLM fetchers still read every product); only the tab state is client-side, which keeps the home page cacheable.
 */
export function RailSwitcher({ panels }: { panels: Record<PanelId, ReactNode> }) {
  const t = useTranslations("rails");
  const [active, setActive] = useState<RailId>("business");
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const activePanel = RAILS.find((r) => r.id === active)!.panel;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const i = RAILS.findIndex((r) => r.id === active);
    const next = e.key === "ArrowRight" ? (i + 1) % RAILS.length : e.key === "ArrowLeft" ? (i - 1 + RAILS.length) % RAILS.length : e.key === "Home" ? 0 : e.key === "End" ? RAILS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const id = RAILS[next]!.id;
    setActive(id);
    refs.current[id]?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label={t("aria")} onKeyDown={onKeyDown} className="-mx-1 flex gap-1.5 overflow-x-auto px-1 [scrollbar-width:none]">
        {RAILS.map((r) => (
          <button
            key={r.id}
            ref={(el) => void (refs.current[r.id] = el)}
            role="tab"
            id={`rail-tab-${r.id}`}
            type="button"
            aria-selected={r.id === active}
            aria-controls={`rail-panel-${r.panel}`}
            tabIndex={r.id === active ? 0 : -1}
            onClick={() => setActive(r.id)}
            className={cn(
              "inline-flex min-h-11 items-center whitespace-nowrap rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
              r.id === active ? "bg-brand-100 text-brand-700" : "text-muted hover:bg-canvas hover:text-ink",
            )}
          >
            {t(r.id)}
          </button>
        ))}
      </div>
      <div className="mt-4">
        {(Object.keys(panels) as PanelId[]).map((p) => (
          <div key={p} role="tabpanel" id={`rail-panel-${p}`} aria-labelledby={`rail-tab-${RAILS.find((r) => r.panel === p && r.id === active)?.id ?? RAILS.find((r) => r.panel === p)!.id}`} hidden={p !== activePanel}>
            {panels[p]}
          </div>
        ))}
      </div>
    </div>
  );
}
