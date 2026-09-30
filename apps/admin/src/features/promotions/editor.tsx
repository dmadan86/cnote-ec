"use client";
import { useActionState, useState } from "react";
import { Alert, Field, Input, Select, Textarea } from "@cnote/ui";
import type { ActionResult } from "@cnote/next-kit";
import { SubmitButton } from "@/components/action-form";
import { savePromotionAction } from "./actions";

// Mirrors the code-defined layouts in @cnote/promotions (kept inline: that package is server-only).
const TEMPLATES: Record<string, string[]> = {
  hero_banner: ["hero_split", "hero_full_bleed"],
  collection: ["collection_rail"],
  category_spotlight: ["category_spotlight"],
  announcement_strip: ["strip"],
};
const KIND_LABEL: Record<string, string> = { hero_banner: "Hero banner", collection: "Curated collection", category_spotlight: "Category spotlight", announcement_strip: "Announcement strip" };
const SURFACES: [string, string][] = [["home_hero", "Home: hero area"], ["home_strip", "Home: announcement strip"], ["home_category_tile", "Home: category tile"], ["home_panel", "Home: collections and panels"], ["category_top", "Category page top"]];
const LOCALES: [string, string][] = [["en", "English (required)"], ["hi", "Hindi"], ["bn", "Bengali"], ["gu", "Gujarati"], ["kn", "Kannada"], ["mr", "Marathi"], ["ta", "Tamil"], ["te", "Telugu"]];

export interface EditorValue {
  id?: string;
  kind: string;
  template: string;
  internalName: string;
  surfaces: string[];
  priority: number;
  startsAt: string; // datetime-local, IST
  endsAt: string;
  segment: string;
  states: string;
  languages: string[];
  items: string;
  contents: Record<string, { headline?: string; subline?: string | null; ctaLabel?: string | null; ctaHref?: string | null; imageKey?: string | null; altText?: string | null }>;
}

function ImageField({ locale, initial, alt }: { locale: string; initial: string; alt: string }) {
  const [url, setUrl] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-2">
      <Field label="Image" htmlFor={`${locale}-img`} hint="JPEG, PNG or WebP up to 2 MB. Uploaded to our media store; never a link to another site.">
        <input id={`${locale}-img`} type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} className="block w-full text-sm"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setMsg(null);
            const fd = new FormData();
            fd.set("file", file);
            fd.set("alt", alt);
            try {
              const r = await fetch("/promotions/assets", { method: "POST", body: fd });
              const j = (await r.json()) as { url?: string; error?: string };
              if (!r.ok || !j.url) setMsg(j.error ?? "Upload failed.");
              else setUrl(j.url);
            } catch {
              setMsg("Upload failed. Check your connection.");
            } finally {
              setBusy(false);
            }
          }} />
      </Field>
      <input type="hidden" name={`${locale}.imageKey`} value={url} />
      {url ? <p className="text-xs text-muted">Current image: <code>{url}</code> <button type="button" className="text-brand-700 underline" onClick={() => setUrl("")}>Remove</button></p> : null}
      <p role="status" className="text-xs text-danger">{msg}</p>
    </div>
  );
}

export function PromotionEditor({ value }: { value: EditorValue }) {
  const [state, action] = useActionState<ActionResult | null, FormData>(savePromotionAction, null);
  const [kind, setKind] = useState(value.kind);
  const [alts, setAlts] = useState<Record<string, string>>(Object.fromEntries(Object.entries(value.contents).map(([l, c]) => [l, c.altText ?? ""])));
  return (
    <form action={action} className="space-y-6">
      {value.id ? <input type="hidden" name="id" value={value.id} /> : null}
      <fieldset className="grid gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-ink">Basics</legend>
        <Field label="Internal name" htmlFor="p-name" hint="Staff-facing only, e.g. Diwali gifting 2026"><Input id="p-name" name="internalName" required maxLength={120} defaultValue={value.internalName} /></Field>
        <Field label="Priority" htmlFor="p-prio" hint="Higher wins when several are live on one surface."><Input id="p-prio" name="priority" type="number" min={0} max={1000} defaultValue={value.priority} /></Field>
        <Field label="Type" htmlFor="p-kind">
          <Select id="p-kind" name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </Select>
        </Field>
        <Field label="Layout" htmlFor="p-tpl" hint="Layouts are fixed in code so the page stays fast on 3G.">
          <Select id="p-tpl" name="template" defaultValue={value.template} key={kind}>
            {TEMPLATES[kind]!.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold text-ink">Where it appears</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {SURFACES.map(([v, l]) => (
            <label key={v} className="flex min-h-9 items-center gap-2 text-sm"><input type="checkbox" name="surfaces" value={v} defaultChecked={value.surfaces.includes(v)} className="size-4" /> {l}</label>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-4 md:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-ink">Schedule (India time)</legend>
        <Field label="Starts" htmlFor="p-start"><Input id="p-start" name="startsAt" type="datetime-local" required defaultValue={value.startsAt} /></Field>
        <Field label="Ends" htmlFor="p-end" hint="At most 180 days. There is no countdown on the site: only the real dates are shown."><Input id="p-end" name="endsAt" type="datetime-local" required defaultValue={value.endsAt} /></Field>
      </fieldset>

      <fieldset className="grid gap-4 md:grid-cols-3">
        <legend className="mb-2 text-sm font-semibold text-ink">Audience (rule based, no profiling)</legend>
        <Field label="Segment" htmlFor="p-seg">
          <Select id="p-seg" name="segment" defaultValue={value.segment}>
            <option value="all">Everyone</option><option value="signed_in">Signed in</option><option value="buyers">Buyers</option><option value="sellers">Sellers</option>
          </Select>
        </Field>
        <Field label="States (comma separated)" htmlFor="p-states" hint="Empty = all of India."><Input id="p-states" name="states" defaultValue={value.states} /></Field>
        <fieldset>
          <legend className="text-sm font-medium text-ink">Only these languages</legend>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {LOCALES.map(([v]) => <label key={v} className="flex items-center gap-1 text-sm"><input type="checkbox" name="languages" value={v} defaultChecked={value.languages.includes(v)} className="size-4" /> {v}</label>)}
          </div>
        </fieldset>
      </fieldset>

      {LOCALES.map(([l, label], i) => {
        const c = value.contents[l] ?? {};
        return (
          <details key={l} open={i < 2 || !!c.headline} className="rounded-card border border-line bg-surface p-4">
            <summary className="cursor-pointer text-sm font-semibold text-ink">Content: {label}</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <Field label="Headline" htmlFor={`${l}-h`}><Input id={`${l}-h`} name={`${l}.headline`} maxLength={120} required={l === "en"} defaultValue={c.headline ?? ""} lang={l} /></Field>
              <Field label="Subline" htmlFor={`${l}-s`}><Input id={`${l}-s`} name={`${l}.subline`} maxLength={240} defaultValue={c.subline ?? ""} lang={l} /></Field>
              <Field label="Button label" htmlFor={`${l}-cl`}><Input id={`${l}-cl`} name={`${l}.ctaLabel`} maxLength={40} defaultValue={c.ctaLabel ?? ""} lang={l} /></Field>
              <Field label="Button link" htmlFor={`${l}-ch`} hint="A path on this site, e.g. /categories/kraft-boxes"><Input id={`${l}-ch`} name={`${l}.ctaHref`} maxLength={300} defaultValue={c.ctaHref ?? ""} /></Field>
              <Field label="Image alt text (required with an image)" htmlFor={`${l}-alt`}>
                <Input id={`${l}-alt`} name={`${l}.altText`} maxLength={300} value={alts[l] ?? ""} onChange={(e) => setAlts((a) => ({ ...a, [l]: e.target.value }))} lang={l} />
              </Field>
              <ImageField locale={l} initial={c.imageKey ?? ""} alt={alts[l] ?? ""} />
            </div>
          </details>
        );
      })}

      {kind === "collection" ? (
        <Field label="Collection picks" htmlFor="p-items" hint="One per line: listing:<id> | reason. Chosen on merit; each pick needs a curator's note (kept for audit). Items must still be live and from a verified seller at render time.">
          <Textarea id="p-items" name="items" rows={6} defaultValue={value.items} className="font-mono text-xs" />
        </Field>
      ) : (
        <input type="hidden" name="items" value={value.items} />
      )}

      <Alert tone="info">Editorial promotions are never sold and never labelled as ads. Saving returns the promotion to draft. A different staff member must approve it before it goes live.</Alert>
      <SubmitButton>{value.id ? "Save draft" : "Create draft"}</SubmitButton>
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
    </form>
  );
}
