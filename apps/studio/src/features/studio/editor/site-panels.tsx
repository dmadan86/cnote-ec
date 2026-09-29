"use client";
import { contrastRatio, FONTS, FONT_KEYS, LIMITS, RADII, themeContrastIssues, type FontKey, type Page, type RadiusKey, type StorefrontDocument, type Theme, AA_TEXT, AA_UI } from "@cnote/storefront/document";
import { Alert, Badge, Field, Input, cn } from "@cnote/ui";
import { ArrowDown, ArrowUp, Plus, Trash2, Check, X } from "lucide-react";
import { useId, useState } from "react";
import { ColorField, iconBtn, SelectField, TextField } from "./fields";
import { ImagePicker } from "./pickers";
import type { SellerImageLite } from "./types";

// ---------------------------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------------------------

const COLORS: { key: keyof Pick<Theme, "primary" | "onPrimary" | "background" | "surface" | "text" | "muted" | "accent">; label: string }[] = [
  { key: "primary", label: "Brand colour (buttons, links)" },
  { key: "onPrimary", label: "Text on brand colour" },
  { key: "background", label: "Page background" },
  { key: "surface", label: "Soft background (tinted bands)" },
  { key: "text", label: "Main text" },
  { key: "muted", label: "Secondary text" },
  { key: "accent", label: "Accent (borders, icons)" },
];

const PAIRS: { a: keyof Theme; b: keyof Theme; label: string; min: number }[] = [
  { a: "text", b: "background", label: "Main text on page background", min: AA_TEXT },
  { a: "text", b: "surface", label: "Main text on soft background", min: AA_TEXT },
  { a: "muted", b: "background", label: "Secondary text on page background", min: AA_TEXT },
  { a: "muted", b: "surface", label: "Secondary text on soft background", min: AA_TEXT },
  { a: "primary", b: "background", label: "Brand colour on page background", min: AA_TEXT },
  { a: "primary", b: "surface", label: "Brand colour on soft background", min: AA_TEXT },
  { a: "onPrimary", b: "primary", label: "Button text on brand colour", min: AA_TEXT },
  { a: "accent", b: "background", label: "Accent on page background", min: AA_UI },
];

export function ThemePanel({ theme, onChange, images, sellerName }: { theme: Theme; onChange: (t: Theme) => void; images: SellerImageLite[]; sellerName: string }) {
  const issues = themeContrastIssues(theme);
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">Pick your colours and font. Colour pairs must meet accessibility contrast (WCAG AA) so every buyer can read your storefront; the checks below update as you type and unreadable combinations cannot be saved.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {COLORS.map((c) => <ColorField key={c.key} label={c.label} value={theme[c.key]} onChange={(v) => onChange({ ...theme, [c.key]: v })} />)}
      </div>
      <section aria-labelledby="contrast-h" className="space-y-2">
        <h3 id="contrast-h" className="text-sm font-semibold text-ink">Readability checks</h3>
        {issues.length === 0 ? <Alert tone="success">All colour pairs meet WCAG AA contrast.</Alert> : <Alert tone="danger">Fix the colours marked below before this can be saved.</Alert>}
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">
          {PAIRS.map((p) => {
            const ratio = contrastRatio(theme[p.a] as string, theme[p.b] as string);
            const pass = ratio + 1e-9 >= p.min;
            return (
              <li key={p.label} className="flex items-center gap-3 px-3 py-2">
                <span className="grid size-7 shrink-0 place-items-center rounded border border-line text-xs font-bold" style={{ background: theme[p.b] as string, color: theme[p.a] as string }} aria-hidden>Aa</span>
                <span className="min-w-0 flex-1">{p.label}</span>
                <span className="tabular-nums text-muted">{ratio.toFixed(1)}:1</span>
                {pass ? <Badge tone="success"><Check className="size-3" aria-hidden /> Pass</Badge> : <Badge tone="danger"><X className="size-3" aria-hidden /> Needs {p.min}:1</Badge>}
              </li>
            );
          })}
        </ul>
      </section>
      <SelectField label="Font" value={theme.font} onChange={(font: FontKey) => onChange({ ...theme, font })} options={FONT_KEYS.map((f) => ({ value: f, label: FONTS[f].label }))} hint={<span style={{ fontFamily: FONTS[theme.font].stack }}>The quick brown fox jumps over the lazy dog.</span>} />
      <SelectField label="Corner style" value={theme.radius} onChange={(radius: RadiusKey) => onChange({ ...theme, radius })} options={(Object.keys(RADII) as RadiusKey[]).map((r) => ({ value: r, label: { none: "Square", sm: "Slightly rounded", md: "Rounded", lg: "Very rounded", xl: "Pill-like" }[r] }))} />
      <ImagePicker label="Logo" value={theme.logo} images={images} onChange={(logo) => onChange({ ...theme, logo })} defaultAlt={sellerName} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

export function PagesPanel({ doc, pageSlug, onSelect, onChange }: { doc: StorefrontDocument; pageSlug: string; onSelect: (slug: string) => void; onChange: (pages: Page[]) => void }) {
  const [title, setTitle] = useState("");
  const addId = useId();
  const pages = doc.pages;
  const setPage = (i: number, patch: Partial<Page>) => onChange(pages.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 1 || j >= pages.length) return;
    const next = [...pages];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const add = () => {
    const t = title.trim();
    if (!t || pages.length >= LIMITS.pages) return;
    let slug = slugify(t) || "page";
    for (let n = 2; pages.some((p) => p.slug === slug) || ["preview", "api", "media", "static", "home"].includes(slug); n++) slug = `${slugify(t) || "page"}-${n}`.slice(0, 30);
    const id = `about-${Date.now().toString(36)}`.slice(0, 32);
    onChange([...pages, { slug, title: t.slice(0, LIMITS.title), seo: { title: "", description: "" }, sections: [{ id, type: "about", tone: "default", title: t.slice(0, LIMITS.title), body: [{ type: "p", children: [{ text: "Write something here." }] }], image: null }] }]);
    setTitle("");
    onSelect(slug);
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Your storefront can have up to {LIMITS.pages} pages. The first page is your home page. Each page gets its own address and search listing.</p>
      <ol className="space-y-3">
        {pages.map((p, i) => (
          <li key={p.slug} className={cn("rounded-lg border p-3", p.slug === pageSlug ? "border-brand-600 bg-brand-50" : "border-line bg-surface")}>
            <div className="space-y-3">
              <TextField label="Page title" value={p.title} max={LIMITS.title} onChange={(t) => setPage(i, { title: t })} />
              {i === 0 ? <p className="text-xs text-muted">Address: your storefront home</p> : (
                <TextField label="Page address" value={p.slug} max={30} hint="Lowercase letters, digits and hyphens." onChange={(v) => setPage(i, { slug: slugify(v) || p.slug })} />
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <button type="button" className="inline-flex h-9 items-center rounded-full border border-line bg-surface px-3 text-sm font-medium hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600" onClick={() => onSelect(p.slug)} aria-pressed={p.slug === pageSlug}>{p.slug === pageSlug ? "Editing" : "Edit this page"}</button>
              {i > 0 ? (
                <>
                  <button type="button" className={iconBtn} aria-label={`Move page ${p.title} up`} disabled={i <= 1} onClick={() => move(i, -1)}><ArrowUp className="size-4" aria-hidden /></button>
                  <button type="button" className={iconBtn} aria-label={`Move page ${p.title} down`} disabled={i === pages.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" aria-hidden /></button>
                  <button type="button" className={cn(iconBtn, "ml-auto text-danger")} aria-label={`Delete page ${p.title}`} onClick={() => { if (window.confirm(`Delete the page "${p.title}"? You can undo this.`)) { onChange(pages.filter((_, k) => k !== i)); onSelect("home"); } }}><Trash2 className="size-4" aria-hidden /></button>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      {pages.length < LIMITS.pages ? (
        <div className="flex items-end gap-2">
          <Field label="New page title" htmlFor={addId} className="flex-1"><Input id={addId} value={title} maxLength={LIMITS.title} placeholder="e.g. Contact" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} /></Field>
          <button type="button" onClick={add} disabled={!title.trim()} className="inline-flex h-10 items-center gap-1.5 rounded-full bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50"><Plus className="size-4" aria-hidden /> Add page</button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// SEO
// ---------------------------------------------------------------------------------------------

export function SeoPanel({ page, onChange, storeName, address }: { page: Page; onChange: (seo: Page["seo"]) => void; storeName: string; address: string }) {
  const title = page.seo.title || (page.slug === "home" ? storeName : `${page.title} | ${storeName}`);
  const desc = page.seo.description || "No description yet. Search engines will pick text from the page.";
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">How this page appears in Google and when shared. Write for buyers: what you make, where you are and what you offer.</p>
      <TextField label="Search title" value={page.seo.title} max={LIMITS.seoTitle} hint="Leave empty to use the page title." onChange={(t) => onChange({ ...page.seo, title: t })} />
      <TextField label="Search description" value={page.seo.description} max={LIMITS.seoDescription} multiline rows={3} onChange={(d) => onChange({ ...page.seo, description: d })} />
      <div className="rounded-lg border border-line bg-surface p-3" aria-label="Search result preview" role="group">
        <p className="truncate text-xs text-muted">{address}</p>
        <p className="mt-0.5 truncate text-base font-medium text-brand-700">{title}</p>
        <p className="mt-0.5 line-clamp-2 text-sm text-ink">{desc}</p>
      </div>
    </div>
  );
}

