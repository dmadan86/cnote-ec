"use client";
import Link from "next/link";
import { useId, useOptimistic, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Select } from "@cnote/ui";
import type { Availability } from "@cnote/catalogue";
import { quickStockAction } from "./stock-actions";
import { AVAILABILITY_OPTIONS } from "./stock-form";

/**
 * Quick stock status control for one row of the listings table. Optimistic: the new state shows at once and reverts with an
 * error if the server refuses it. "Made to order" asks for the lead time first. Listings with variants link to the editor.
 */
export function StockToggle({
  listingId,
  title,
  availability,
  leadTimeDays,
  variantCount,
}: {
  listingId: string;
  title: string;
  availability: Availability;
  leadTimeDays: number | null;
  variantCount: number;
}) {
  const t = useTranslations("stock");
  const uid = useId();
  const [committed, setCommitted] = useState(availability);
  const [lead, setLead] = useState<number | null>(leadTimeDays);
  const [optimistic, setOptimistic] = useOptimistic(committed);
  const [asking, setAsking] = useState(false);
  const [leadInput, setLeadInput] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();

  if (variantCount > 0) {
    return (
      <Link href={`/listings/${listingId}/edit#variants`} className="text-sm font-medium text-brand underline-offset-2 hover:underline">
        {t("toggle.manage")}
      </Link>
    );
  }

  const apply = (next: Availability, leadDays: number | null) => {
    setMessage(null);
    start(async () => {
      setOptimistic(next);
      const fd = new FormData();
      fd.set("id", listingId);
      fd.set("availability", next);
      if (leadDays !== null) fd.set("leadTimeDays", String(leadDays));
      const res = await quickStockAction(null, fd);
      if (res.ok) {
        setCommitted(res.data.availability);
        setLead(res.data.leadTimeDays);
        setMessage({ tone: "ok", text: t("toggle.saved", { state: t(`availability.${res.data.availability}`) }) });
      } else {
        setMessage({ tone: "error", text: res.error });
      }
    });
  };

  const onChange = (next: Availability) => {
    if (next === committed) return;
    if (next === "made_to_order" && lead === null) {
      setAsking(true);
      setMessage(null);
      return;
    }
    setAsking(false);
    apply(next, null);
  };

  return (
    <div className="space-y-2">
      <label htmlFor={`${uid}-s`} className="sr-only">{t("toggle.label", { title })}</label>
      <Select
        id={`${uid}-s`}
        value={asking ? "made_to_order" : optimistic}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as Availability)}
        className="h-11 w-auto min-w-44"
      >
        {AVAILABILITY_OPTIONS.map((a) => <option key={a} value={a}>{t(`availability.${a}`)}</option>)}
      </Select>
      {asking ? (
        <div className="flex flex-wrap items-end gap-2" role="group" aria-labelledby={`${uid}-p`}>
          <p id={`${uid}-p`} className="w-full text-xs text-muted">{t("toggle.leadTimePrompt")}</p>
          <div>
            <label htmlFor={`${uid}-l`} className="block text-xs text-ink">{t("toggle.leadTime")}</label>
            <Input id={`${uid}-l`} inputMode="numeric" value={leadInput} onChange={(e) => setLeadInput(e.target.value)} className="h-11 w-28" />
          </div>
          <Button
            type="button"
            size="md"
            className="min-h-11"
            disabled={pending}
            onClick={() => {
              const n = Number(leadInput);
              if (leadInput.trim() === "" || !Number.isInteger(n) || n < 0 || n > 730) {
                setMessage({ tone: "error", text: t("actions.leadTimeNeeded") });
                return;
              }
              setAsking(false);
              apply("made_to_order", n);
            }}
          >
            {t("toggle.apply")}
          </Button>
          <Button type="button" variant="outline" size="md" className="min-h-11" onClick={() => { setAsking(false); setMessage(null); }}>{t("toggle.cancel")}</Button>
        </div>
      ) : null}
      <p role={message?.tone === "error" ? "alert" : "status"} aria-live="polite" className={`min-h-4 text-xs ${message?.tone === "error" ? "text-danger" : "text-muted"}`}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}
