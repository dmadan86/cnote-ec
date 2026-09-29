"use client";
import { useEffect, useState } from "react";

/** Debounced callback: the latest call wins; `flush()` runs a pending call now, `cancel()` drops it. */
export function useDebouncedCallback<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  const [api] = useState(() => {
    const st: { fn: (...a: A) => void; timer: ReturnType<typeof setTimeout> | null; pending: A | null; ms: number } = { fn, timer: null, pending: null, ms };
    const cancel = () => {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      st.pending = null;
    };
    const flush = () => {
      const p = st.pending;
      cancel();
      if (p) st.fn(...p);
    };
    const call = (...a: A) => {
      st.pending = a;
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(flush, st.ms);
    };
    const update = (nextFn: (...a: A) => void, nextMs: number) => { st.fn = nextFn; st.ms = nextMs; };
    return { update, call: Object.assign(call, { flush, cancel }) };
  });
  useEffect(() => {
    api.update(fn, ms);
  });
  useEffect(() => () => api.call.cancel(), [api]);
  return api.call;
}
/** Sandboxed preview: srcdoc + sandbox="" (no scripts, no same-origin, no forms). Width toggles desktop / mobile. */
export function PreviewFrame({ html, title, loading, error }: { html: string | null; title: string; loading?: boolean; error?: string | null }) {
  const [mobile, setMobile] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Preview {loading ? <span className="font-normal text-muted">(updating…)</span> : null}</h3>
        <div role="group" aria-label="Preview width" className="inline-flex overflow-hidden rounded-full border border-line text-xs font-medium">
          <button type="button" aria-pressed={!mobile} onClick={() => setMobile(false)} className={`px-3 py-1 ${!mobile ? "bg-brand-600 text-white" : "bg-surface hover:bg-canvas"}`}>Desktop</button>
          <button type="button" aria-pressed={mobile} onClick={() => setMobile(true)} className={`px-3 py-1 ${mobile ? "bg-brand-600 text-white" : "bg-surface hover:bg-canvas"}`}>Mobile</button>
        </div>
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-danger">{error}</p> : null}
      <div className="overflow-auto rounded-lg border border-line bg-canvas p-2">
        <iframe
          title={title}
          sandbox=""
          srcDoc={html ?? ""}
          referrerPolicy="no-referrer"
          className="mx-auto block h-[560px] rounded bg-white transition-[width]"
          style={{ width: mobile ? 375 : "100%" }}
        />
      </div>
    </div>
  );
}

export function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}
