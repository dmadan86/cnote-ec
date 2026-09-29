"use client";
import { useState } from "react";
import { Button } from "@cnote/ui";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="min-h-8"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="sr-only">{copied ? `${label} copied` : ""}</span>
    </>
  );
}
