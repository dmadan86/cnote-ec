"use client";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@cnote/ui";

export function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useTranslations("storefront.copy");
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="min-h-8"
        aria-label={t("aria", { label })}
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
        {copied ? t("copied") : t("copy")}
      </Button>
      <span role="status" className="sr-only">{copied ? t("done", { label }) : ""}</span>
    </>
  );
}
