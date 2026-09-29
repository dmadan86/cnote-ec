"use client";
import { Heart } from "lucide-react";
import { useState, useTransition } from "react";
import { cn } from "../cn";

/** Result of the app's toggle action (a server action). `saved` is the new state on success. */
export type WishlistToggleResult = { ok: true; saved: boolean } | { ok: false; error?: string };

/**
 * Heart toggle for a signed-in person's saved items. State lives on the server: the app passes the
 * current `saved` value and `onToggle` (a server action). Without `onToggle` (guest) a click sends the
 * person to `signInPath?next=<current page>`.
 */
export function WishlistButton({
  id,
  title,
  saved: initialSaved = false,
  onToggle,
  signInPath = "/signin",
  className,
}: {
  id: string;
  title: string;
  saved?: boolean;
  onToggle?: (id: string) => Promise<WishlistToggleResult>;
  signInPath?: string;
  className?: string;
}) {
  const [prev, setPrev] = useState(initialSaved);
  const [saved, setSaved] = useState(initialSaved);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Re-sync when the server re-renders with a different value (e.g. after a refresh).
  if (prev !== initialSaved) {
    setPrev(initialSaved);
    setSaved(initialSaved);
  }

  function click() {
    if (!onToggle) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`${signInPath}?next=${encodeURIComponent(next)}`);
      return;
    }
    const before = saved;
    setSaved(!before);
    setError(null);
    start(async () => {
      try {
        const r = await onToggle(id);
        if (r.ok) setSaved(r.saved);
        else {
          setSaved(before);
          setError(r.error ?? "Couldn't update your saved items.");
        }
      } catch {
        setSaved(before);
        setError("Couldn't update your saved items.");
      }
    });
  }

  return (
    <>
      <button
        type="button"
        aria-pressed={saved}
        aria-busy={pending}
        aria-label={saved ? `Remove ${title} from saved items` : `Save ${title}`}
        title={saved ? "Saved" : onToggle ? "Save" : "Sign in to save"}
        onClick={click}
        className={cn(
          "inline-flex size-8 items-center justify-center rounded-full bg-surface/95 shadow-sm ring-1 ring-line transition-colors hover:bg-brand-50 focus-visible:outline-2 focus-visible:outline-brand-600",
          className,
        )}
      >
        <Heart className={cn("size-4", saved ? "fill-danger text-danger" : "text-muted")} aria-hidden />
      </button>
      <span role="status" className="sr-only">
        {error ?? ""}
      </span>
    </>
  );
}
