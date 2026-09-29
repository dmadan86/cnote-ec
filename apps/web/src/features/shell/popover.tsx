"use client";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { cn } from "@cnote/ui";

/**
 * Accessible disclosure popover (click to toggle, Esc / outside click / link click closes).
 * Children may be a render function when the panel needs to close itself.
 */
export function Popover({
  label,
  children,
  align = "left",
  buttonClassName,
  panelClassName,
  chevron = true,
  ariaLabel,
}: {
  label: ReactNode;
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  align?: "left" | "right";
  buttonClassName?: string;
  panelClassName?: string;
  chevron?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        ref.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div
      ref={ref}
      className="relative"
      // Keyboard users tabbing out of the open panel close it (WCAG 2.1.1 / 2.4.3: no orphaned open menus).
      onBlur={(e) => {
        if (open && e.relatedTarget && ref.current && !ref.current.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex min-h-11 items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium text-ink hover:text-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
          buttonClassName,
        )}
      >
        {label}
        {chevron ? <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} aria-hidden /> : null}
      </button>
      <div
        id={id}
        hidden={!open}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("a")) setOpen(false);
        }}
        className={cn(
          "absolute top-full z-50 mt-2 min-w-64 rounded-card border border-line bg-surface p-2 shadow-lg",
          align === "right" ? "right-0" : "left-0",
          panelClassName,
        )}
      >
        {typeof children === "function" ? children({ close: () => setOpen(false) }) : children}
      </div>
    </div>
  );
}
