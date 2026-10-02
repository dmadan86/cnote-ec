"use client";
import { useState } from "react";
import { Check, Share2 } from "lucide-react";
import { buttonClasses } from "@cnote/ui";

/** Native share sheet when available, otherwise copies the link. Result is announced via aria-live. */
export function ShareButton({ label, copiedLabel, title }: { label: string; copiedLabel: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    const url = window.location.href.split("#")[0]!;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* user cancelled or clipboard blocked: nothing to do */
    }
  };
  return (
    <>
      <button type="button" onClick={onClick} className={buttonClasses("outline", "md")}>
        {copied ? <Check className="size-4" aria-hidden /> : <Share2 className="size-4" aria-hidden />} {label}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
