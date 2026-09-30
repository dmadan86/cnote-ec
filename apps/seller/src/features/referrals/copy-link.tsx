"use client";
import { useState } from "react";
import { Button } from "@cnote/ui";

/** Copies the referral link. Falls back to selecting the field when the clipboard API is unavailable. */
export function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <label htmlFor="ref-link" className="sr-only">Your referral link</label>
      <input id="ref-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-lg border border-line bg-canvas px-3 text-sm text-ink" />
      <Button
        type="button"
        variant="primary"
        className="min-h-11"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        Copy link
      </Button>
      <span role="status" className="sr-only">{copied ? "Link copied" : ""}</span>
      {copied ? <span aria-hidden className="self-center text-sm text-success">Copied</span> : null}
    </div>
  );
}
