"use client";
import { useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@cnote/ui";

const readHash = () => window.location.hash.replace(/^#/, "");
const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export interface ProfileTab {
  id: string;
  label: string;
  panel: ReactNode;
}

/**
 * WAI-ARIA tabs (automatic activation, roving tabindex, Arrow/Home/End). The active tab lives in the URL hash
 * (`#products`), so it is linkable and survives reload. Every panel is rendered on the server (inactive ones are
 * `hidden`), so the page stays static/ISR and crawlers still see all content.
 */
export function ProfileTabs({ tabs, label, initial }: { tabs: ProfileTab[]; label: string; initial?: string }) {
  const ids = tabs.map((t) => t.id);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const hash = useSyncExternalStore(subscribeHash, readHash, () => "");
  const fallback = initial && ids.includes(initial) ? initial : ids[0]!;
  const active = ids.includes(hash) ? hash : fallback;

  const select = (id: string, focus = false) => {
    try {
      window.history.replaceState(null, "", `#${id}`);
      window.dispatchEvent(new HashChangeEvent("hashchange")); // replaceState is silent: tell the store
    } catch {
      /* history unavailable: the tab keeps its server-rendered default */
    }
    if (focus) refs.current[id]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next]!.id, true);
  };

  return (
    <div>
      <div role="tablist" aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1 [scrollbar-width:none]">
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[t.id] = el;
              }}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={on}
              aria-controls={`panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => select(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                "inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-4 py-2 text-sm font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-600",
                on ? "border-brand-600 text-brand-700" : "border-transparent text-muted hover:text-ink",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" id={`panel-${t.id}`} aria-labelledby={`tab-${t.id}`} hidden={t.id !== active} tabIndex={0} className="pt-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
          {t.panel}
        </div>
      ))}
    </div>
  );
}
