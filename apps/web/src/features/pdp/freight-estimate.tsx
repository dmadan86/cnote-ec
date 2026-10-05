"use client";
// "Estimate freight to <PIN>" panel on the product page (docs/design/freight-estimator.md). A client island because the page is
// static (ISR): the deliver-to PIN lives in a cookie and the estimate is fetched on demand from /api/freight/estimate.
// Always labelled as an estimate; the final freight is quoted by the seller.
import { useId, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Button, Field, Input } from "@cnote/ui";
import { PINCODE_COOKIE } from "@/features/shell/site";
import { formatPaise } from "./tiers";

const noopSubscribe = () => () => undefined;
const readCookiePin = (): string => document.cookie.match(new RegExp(`(?:^|; )${PINCODE_COOKIE}=(\\d{6})`))?.[1] ?? "";

interface Estimate {
  quantity: number;
  unit: string | null;
  estimate: {
    mode: "parcel" | "ltl" | "ftl";
    chargeableWeightKg: number;
    vehicles: number;
    lowPaise: number;
    highPaise: number;
    gstLowPaise: number;
    gstHighPaise: number;
    gstRateBps: number;
    transitDays: { min: number; max: number };
    assumptions: string[];
  };
  unitPricePaise: number | null;
  goodsPaise: number | null;
  landed: { low: { totalPaise: number }; high: { totalPaise: number } } | null;
}

export interface FreightEstimateProps {
  listingId: string;
  /** price unit shown next to the quantity */
  unit: string | null;
  moq: number | null;
}

const ERRORS = new Set(["invalid_pincode", "invalid_quantity", "rate_limited", "unavailable", "not_found"]);

export function FreightEstimate({ listingId, unit, moq }: FreightEstimateProps) {
  const t = useTranslations("freight");
  const uid = useId();
  const cookiePin = useSyncExternalStore(noopSubscribe, readCookiePin, () => "");
  const [pinDraft, setPinDraft] = useState<string | null>(null);
  const [qty, setQty] = useState(String(moq ?? 1));
  const [state, setState] = useState<{ kind: "idle" } | { kind: "loading" } | { kind: "error"; code: string } | { kind: "ok"; data: Estimate; pin: string }>({ kind: "idle" });
  const pin = (pinDraft ?? cookiePin).trim();
  const pinOk = /^[1-9]\d{5}$/.test(pin);
  const qtyNum = Number(qty);
  const qtyOk = Number.isInteger(qtyNum) && qtyNum >= 1;
  const [touched, setTouched] = useState(false);
  const range = (lo: number, hi: number) => t("range", { low: formatPaise(lo), high: formatPaise(hi) });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!pinOk || !qtyOk) return;
    setState({ kind: "loading" });
    try {
      const r = await fetch(`/api/freight/estimate?${new URLSearchParams({ listingId, quantity: String(qtyNum), pincode: pin })}`, { headers: { accept: "application/json" } });
      const body = (await r.json()) as Estimate & { error?: string };
      if (!r.ok) setState({ kind: "error", code: ERRORS.has(body.error ?? "") ? body.error! : "unavailable" });
      else setState({ kind: "ok", data: body, pin });
    } catch {
      setState({ kind: "error", code: "unavailable" });
    }
  }

  const ok = state.kind === "ok" ? state : null;
  const e = ok?.data.estimate;
  const days = e ? (e.transitDays.min === e.transitDays.max ? t("transitSame", { days: e.transitDays.min }) : t("transitRange", { min: e.transitDays.min, max: e.transitDays.max })) : "";

  return (
    <section aria-labelledby={`${uid}-h`} className="rounded-card border border-line bg-surface p-4" data-testid="freight-estimate">
      <h2 id={`${uid}-h`} className="text-base font-bold text-ink">{pinOk ? t("titleTo", { pincode: pin }) : t("title")}</h2>
      <form onSubmit={submit} noValidate className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
        <Field label={t("pinLabel")} htmlFor={`${uid}-pin`} hint={t("pinHelp")} error={touched && !pinOk ? t("pinInvalid") : undefined}>
          <Input id={`${uid}-pin`} name="pincode" inputMode="numeric" autoComplete="postal-code" maxLength={6} value={pin} onChange={(ev) => setPinDraft(ev.target.value.replace(/\D/g, ""))} className="h-11 max-w-40" />
        </Field>
        <Field label={t("qtyLabel", { unit: unit ?? "" })} htmlFor={`${uid}-qty`} error={touched && !qtyOk ? t("qtyInvalid") : undefined}>
          <Input id={`${uid}-qty`} name="quantity" inputMode="numeric" autoComplete="off" value={qty} onChange={(ev) => setQty(ev.target.value)} className="h-11 max-w-40" />
        </Field>
        <Button type="submit" variant="outline-brand" size="lg" disabled={state.kind === "loading"} className="min-h-11 sm:mb-0.5">
          {state.kind === "loading" ? t("loading") : t("submit")}
        </Button>
      </form>

      <div role="status" aria-live="polite" className="mt-3">
        {state.kind === "error" ? <p className="text-sm text-danger">{t(`err_${state.code}`)}</p> : null}
        {ok && e ? (
          <div className="flex flex-col gap-3" data-testid="freight-result">
            <p className="text-sm text-muted">{t("resultHeading")}</p>
            <p className="text-2xl font-bold text-ink">
              {range(e.lowPaise, e.highPaise)} <span className="text-sm font-normal text-muted">{t("beforeGst")}</span>
            </p>
            <p className="text-sm text-ink">{t("gstLine", { low: formatPaise(e.gstLowPaise), high: formatPaise(e.gstHighPaise) })}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">{t("modeLabel")}</dt>
              <dd className="font-medium text-ink">{t(`mode_${e.mode}`)}{e.vehicles > 1 ? ` (${t("vehicles", { count: e.vehicles })})` : ""}</dd>
              <dt className="text-muted">{t("transitLabel")}</dt>
              <dd className="font-medium text-ink">{days}</dd>
              <dt className="text-muted">{t("weightLabel")}</dt>
              <dd className="font-medium text-ink">{t("weightValue", { kg: e.chargeableWeightKg })}</dd>
            </dl>
            {ok.data.landed && ok.data.goodsPaise != null ? (
              <div className="rounded-lg border border-line bg-canvas p-3" data-testid="freight-landed">
                <h3 className="text-sm font-semibold text-ink">{t("landedTitle")}</h3>
                <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">{t("landedGoods", { qty: ok.data.quantity, unit: ok.data.unit ?? "" })}</dt>
                  <dd className="text-right tabular-nums text-ink">{formatPaise(ok.data.goodsPaise)}</dd>
                  <dt className="text-muted">{t("landedFreight")}</dt>
                  <dd className="text-right tabular-nums text-ink">{range(e.lowPaise, e.highPaise)}</dd>
                  <dt className="text-muted">{t("landedFreightGst")}</dt>
                  <dd className="text-right tabular-nums text-ink">{range(e.gstLowPaise, e.gstHighPaise)}</dd>
                  <dt className="border-t border-line pt-1 font-semibold text-ink">{t("landedTotal")}</dt>
                  <dd className="border-t border-line pt-1 text-right font-semibold tabular-nums text-ink">{range(ok.data.landed.low.totalPaise, ok.data.landed.high.totalPaise)}</dd>
                </dl>
                <p className="mt-2 text-xs text-muted">{t("landedNote")}</p>
              </div>
            ) : null}
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-2 font-medium text-brand-700">{t("assumptionsTitle")}</summary>
              <ul className="ml-4 list-disc space-y-1 text-muted">
                {e.assumptions.map((a) => (
                  <li key={a}>{t(`a_${a}`)}</li>
                ))}
              </ul>
            </details>
          </div>
        ) : null}
      </div>
      {/* Always visible, not only after a result: the figure is never a quote. */}
      <p className="mt-3 text-xs font-medium text-ink">{t("disclaimer")}</p>
    </section>
  );
}
