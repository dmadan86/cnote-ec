"use client";
import { useEffect, useRef, useState } from "react";
import { lookupBenchmarkAction } from "./actions";
import type { PublicBenchmark } from "@cnote/prices";

export interface HintLabels {
  title: string; sectionLabel: string; widerArea: string; checking: string;
  /** ICU-formatted on the server is impossible (values are live), so templates use {token} replaced here */
  range: string; basis: string; trendUp: string; trendDown: string; trendFlat: string;
}

const FIELDS = ["categorySlug", "quantity", "quantityUnit", "deliveryPincode"] as const;
const inr = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: paise % 100 === 0 ? 0 : 2 }).format(paise / 100);
const fill = (tpl: string, v: Record<string, string>) => tpl.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? "");
const el = (id: string) => document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;

/**
 * "Typical price range" hint for the RFQ form (ADR-022). It watches the form's own fields (category, quantity, unit,
 * pincode) and shows the state-level band once a category is chosen. WCAG 2.2 AA: a labelled region, a polite live
 * region for updates (no focus movement), text (not colour) carries all meaning, and the copy says it is indicative.
 */
export function BenchmarkHint({ labels }: { labels: HintLabels }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "ready"; data: PublicBenchmark | null }>({ status: "idle", data: null });
  const seq = useRef(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = seq;
    const run = () => {
      const categorySlug = el("categorySlug")?.value ?? "";
      if (!categorySlug) { setState({ status: "idle", data: null }); return; }
      const quantity = Number(el("quantity")?.value);
      const my = ++seq.current;
      setState((s) => ({ status: "loading", data: s.data }));
      void lookupBenchmarkAction({
        categorySlug, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
        unit: el("quantityUnit")?.value || null, pincode: el("deliveryPincode")?.value || null,
      }).then((data) => { if (my === seq.current) setState({ status: "ready", data }); }, () => { if (my === seq.current) setState({ status: "ready", data: null }); });
    };
    const onChange = (e: Event) => {
      if (!(e.target instanceof HTMLElement) || !(FIELDS as readonly string[]).includes(e.target.id)) return;
      clearTimeout(timer);
      timer = setTimeout(run, 400);
    };
    document.addEventListener("input", onChange);
    document.addEventListener("change", onChange);
    run();
    return () => { clearTimeout(timer); token.current++; document.removeEventListener("input", onChange); document.removeEventListener("change", onChange); };
  }, []);

  const d = state.data;
  return (
    <section aria-labelledby="price-hint-heading" className="mb-6 rounded-card border border-line bg-surface p-4" hidden={state.status === "idle"}>
      <h2 id="price-hint-heading" className="text-sm font-semibold text-ink">{labels.title}</h2>
      <div role="status" aria-live="polite" className="mt-2 space-y-1 text-sm text-ink">
        {state.status === "loading" && !d ? <p className="text-muted">{labels.checking}</p> : null}
        {d ? (
          <>
            <p>{fill(labels.range, { region: d.scope.regionLabel, low: inr(d.p25Paise), high: inr(d.p75Paise), median: inr(d.medianPaise), unit: d.unit })}</p>
            {d.scope.rolledUp ? <p className="text-muted">{labels.widerArea}</p> : null}
            {d.trendBps !== null ? (
              <p>{Math.abs(d.trendBps) <= 200 ? labels.trendFlat : fill(d.trendBps > 0 ? labels.trendUp : labels.trendDown, { percent: String(Math.round(Math.abs(d.trendBps) / 100)) })}</p>
            ) : null}
            <p className="text-muted">{fill(labels.basis, { count: String(d.sampleCount) })}</p>
          </>
        ) : null}
      </div>
    </section>
  );
}
