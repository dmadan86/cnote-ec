"use client";
import { Scale } from "lucide-react";
import { useState, useTransition } from "react";
import { cn } from "../cn";

/** Result of the app's compare action (a server action that edits the compare cookie). */
export type CompareToggleResult =
  | { status: "added" }
  | { status: "removed" }
  | { status: "full"; message: string }
  | { status: "category_mismatch"; message: string }
  | { status: "error"; message: string };

/**
 * "Compare" toggle. `inTray` comes from the server (cookie). `onToggle(id, {replace})` is a server
 * action; when the product's category differs from the tray it answers `category_mismatch` and we ask
 * before replacing the tray.
 */
export function CompareToggle({
  id,
  title,
  inTray,
  onToggle,
  variant = "chip",
  className,
  labels,
}: {
  id: string;
  title: string;
  inTray: boolean;
  onToggle: (id: string, opts?: { replace?: boolean }) => Promise<CompareToggleResult>;
  variant?: "chip" | "button";
  className?: string;
  /** Translated strings (defaults are English). `add`/`remove` use the `{title}` placeholder. */
  labels?: { add?: string; remove?: string; inCompare?: string; compare?: string; replaceConfirm?: string; error?: string };
}) {
  const [prev, setPrev] = useState(inTray);
  const [on, setOn] = useState(inTray);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (prev !== inTray) {
    setPrev(inTray);
    setOn(inTray);
  }

  function run(replace?: boolean) {
    setMsg(null);
    start(async () => {
      try {
        const r = await onToggle(id, replace ? { replace: true } : undefined);
        if (r.status === "added" || r.status === "removed") setOn(r.status === "added");
        else if (r.status === "category_mismatch") {
          const ok = window.confirm(`${r.message}\n\n${labels?.replaceConfirm ?? "Replace the products in your compare tray with this one?"}`);
          if (ok) run(true);
        } else setMsg(r.message);
      } catch {
        setMsg(labels?.error ?? "Couldn't update your compare tray.");
      }
    });
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <button
        type="button"
        aria-pressed={on}
        aria-busy={pending}
        aria-label={(on ? (labels?.remove ?? "Remove {title} from compare") : (labels?.add ?? "Add {title} to compare")).replace("{title}", title)}
        onClick={() => run()}
        className={cn(
          "inline-flex items-center justify-center gap-1.5 rounded-full border font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600",
          variant === "button" ? "min-h-11 px-5 text-sm" : "min-h-8 px-2.5 text-xs",
          on ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line bg-surface text-ink hover:bg-canvas",
        )}
      >
        <Scale className="size-3.5" aria-hidden /> {on ? (labels?.inCompare ?? "In compare") : (labels?.compare ?? "Compare")}
      </button>
      <span role="status" className={cn("text-xs text-danger", msg ? "" : "sr-only")}>
        {msg ?? ""}
      </span>
    </div>
  );
}
