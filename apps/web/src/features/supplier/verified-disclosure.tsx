"use client";
import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, Minus } from "lucide-react";
import { cn } from "@cnote/ui";
import type { EvidenceItem } from "./evidence-items";

/**
 * "What's verified" disclosure: a button with aria-expanded controlling an inline panel (works by keyboard, touch
 * and screen reader; never hover-only). Each row states its status in text and with a distinct icon.
 */
export function VerifiedDisclosure({
  label,
  summary,
  listLabel,
  items,
  gstinLine,
  footer,
  className,
}: {
  label: string;
  summary: string;
  listLabel: string;
  items: EvidenceItem[];
  gstinLine?: string | null;
  footer?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        data-testid="whats-verified"
        className="inline-flex min-h-6 items-center gap-1 rounded text-xs font-medium text-brand-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        {label}
        <span className="text-muted">({summary})</span>
        <ChevronDown className={cn("size-3.5 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
      </button>
      <div id={panelId} hidden={!open} className="mt-2 rounded-lg border border-line bg-canvas p-3">
        <ul aria-label={listLabel} className="flex flex-col gap-2.5">
          {items.map((i) => (
            <li key={i.key} className="flex items-start gap-2 text-xs">
              {i.passed ? <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden /> : <Minus className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />}
              <span>
                <span className="block font-semibold text-ink">{i.label}</span>
                <span className="block text-muted">{i.status}</span>
              </span>
            </li>
          ))}
        </ul>
        {gstinLine ? <p className="mt-2 text-xs text-muted">{gstinLine}</p> : null}
        {footer ? <div className="mt-2 text-xs">{footer}</div> : null}
      </div>
    </div>
  );
}
