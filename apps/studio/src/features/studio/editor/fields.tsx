"use client";
import { Field, Input, Select, Textarea, cn } from "@cnote/ui";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { HEX_RE } from "@cnote/storefront/document";

const counter = (v: string, max?: number) => (max ? `${v.length}/${max}` : undefined);

export function TextField({ label, value, onChange, max, hint, multiline, rows = 3, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; max?: number; hint?: ReactNode; multiline?: boolean; rows?: number; placeholder?: string;
}) {
  const id = useId();
  const over = max ? value.length > max : false;
  const note = (
    <>
      {hint ? <>{hint} </> : null}
      {max ? <span className={over ? "font-semibold text-danger" : undefined}>{counter(value, max)}</span> : null}
    </>
  );
  return (
    <Field label={label} htmlFor={id} hint={over ? undefined : note} error={over ? <>Too long. {counter(value, max)}</> : undefined}>
      {multiline ? (
        <Textarea id={id} rows={rows} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </Field>
  );
}

export function SelectField<T extends string>({ label, value, onChange, options, hint }: {
  label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; hint?: ReactNode;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </Field>
  );
}

export function NumberField({ label, value, onChange, min, max, hint }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; hint?: ReactNode }) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} onChange={(e) => onChange(Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min))))} />
    </Field>
  );
}

export function CheckField({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-1 size-4 accent-brand-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id} className="text-sm text-ink">{label}{hint ? <span className="block text-xs text-muted">{hint}</span> : null}</label>
    </div>
  );
}

/** Colour swatch + hex box. The hex box keeps its own draft so half-typed values do not fight the swatch. */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  if (prev !== value) {
    setPrev(value);
    setDraft(value);
  }
  return (
    <Field label={label} htmlFor={id} error={draft && !HEX_RE.test(draft) ? "Use a #rrggbb colour." : undefined}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} colour picker`} value={HEX_RE.test(value) ? value : "#000000"} onChange={(e) => onChange(e.target.value.toLowerCase())} className="h-10 w-12 cursor-pointer rounded-lg border border-line bg-surface p-1" />
        <Input
          id={id}
          value={draft}
          spellCheck={false}
          maxLength={7}
          className="font-mono"
          onChange={(e) => {
            const v = e.target.value.trim();
            setDraft(v);
            if (HEX_RE.test(v)) onChange(v.toLowerCase());
          }}
        />
      </div>
    </Field>
  );
}

export const iconBtn =
  "inline-flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 disabled:pointer-events-none disabled:opacity-40";

/** Ordered list editor with add / remove / move buttons (keyboard friendly; no drag needed). */
export function ListEditor<T>({ label, items, onChange, render, blank, max, min = 0, addLabel = "Add item" }: {
  label: string; items: T[]; onChange: (items: T[]) => void; render: (item: T, set: (patch: Partial<T>) => void, index: number) => ReactNode; blank: () => T; max: number; min?: number; addLabel?: string;
}) {
  const move = (i: number, d: -1 | 1) => {
    const next = [...items];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold text-ink">{label} <span className="font-normal text-muted">({items.length}/{max})</span></legend>
      <ol className="space-y-3">
        {items.map((it, i) => (
          <li key={i} className="rounded-lg border border-line bg-canvas p-3">
            <div className="space-y-3">{render(it, (patch) => onChange(items.map((x, k) => (k === i ? { ...x, ...patch } : x))), i)}</div>
            <div className="mt-3 flex gap-1.5">
              <button type="button" className={iconBtn} aria-label={`Move ${label} item ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" aria-hidden /></button>
              <button type="button" className={iconBtn} aria-label={`Move ${label} item ${i + 1} down`} disabled={i === items.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" aria-hidden /></button>
              <button type="button" className={cn(iconBtn, "ml-auto text-danger")} aria-label={`Remove ${label} item ${i + 1}`} disabled={items.length <= min} onClick={() => onChange(items.filter((_, k) => k !== i))}><Trash2 className="size-4" aria-hidden /></button>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 disabled:opacity-50" disabled={items.length >= max} onClick={() => onChange([...items, blank()])}>
        <Plus className="size-4" aria-hidden /> {addLabel}
      </button>
    </fieldset>
  );
}
