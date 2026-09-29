"use client";
import {
  SECTION_LABELS, SECTION_TYPES, LIMITS, defaultSection, newSectionId, validateDocument, richTextToPlain,
  type Page, type Section, type SectionType, type StorefrontDocument,
} from "@cnote/storefront/document";
import { StorefrontView, type LinkProps, type RenderHrefs } from "@cnote/storefront/render";
import { Alert, Badge, Select, cn } from "@cnote/ui";
import {
  ArrowDown, ArrowUp, CheckCircle2, Copy, ExternalLink, Eye, FileText, Globe, Layers, Loader2, Monitor, Palette, Plus, Redo2, Rocket, Settings2, Smartphone, Trash2, Undo2,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { listVersionsAction, publishAction, reloadDraftAction, saveDraftAction } from "../actions";
import { BlockForm } from "./block-forms";
import { iconBtn } from "./fields";
import { PagesPanel, SeoPanel, ThemePanel } from "./site-panels";
import { SettingsPanel } from "./settings-panel";
import type { EditorData, EditorInitial, VersionLite } from "./types";

type Sel = { kind: "section"; id: string } | { kind: "theme" } | { kind: "pages" } | { kind: "seo" } | { kind: "settings" };
interface Hist {
  doc: StorefrontDocument;
  past: StorefrontDocument[];
  future: StorefrontDocument[];
  at: number;
  reset: number;
}

// The preview renders the real storefront renderer; links inside it switch pages instead of navigating.
const PreviewNav = createContext<(slug: string) => void>(() => undefined);
function PreviewLink({ href, children, className, style, ...rest }: LinkProps) {
  const go = useContext(PreviewNav);
  return (
    <a href={href} className={className} style={style} aria-current={rest["aria-current"]} aria-label={rest["aria-label"]} onClick={(e) => { e.preventDefault(); if (href.startsWith("#page:")) go(href.slice(6)); }}>
      {children}
    </a>
  );
}

const summaryOf = (s: Section): string => {
  switch (s.type) {
    case "hero": return s.headline;
    case "productGrid": case "featuredProduct": case "certifications": case "gallery": case "testimonials": case "faq": case "contact": return s.title;
    case "about": return s.title || richTextToPlain(s.body).slice(0, 40);
    case "stats": return s.items.map((i) => i.value).join(" · ");
    case "spacer": return `${s.size} space`;
    default: return "";
  }
};

const tabBtn = (on: boolean) => cn("inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600", on ? "bg-brand-600 text-white" : "text-ink hover:bg-canvas");
const toolBtn = "inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-sm font-medium text-ink hover:bg-canvas focus-visible:outline-2 focus-visible:outline-brand-600 disabled:pointer-events-none disabled:opacity-40";

export function Editor({ initial, editor }: { initial: EditorInitial; editor: EditorData }) {
  const { data, images } = editor;
  const [h, setH] = useState<Hist>({ doc: initial.document, past: [], future: [], at: 0, reset: 0 });
  const doc = h.doc;
  const [pageSlug, setPageSlug] = useState("home");
  const [sel, setSel] = useState<Sel | null>(() => {
    const first = initial.document.pages[0]?.sections.find((s) => s.type !== "trustStrip");
    return first ? { kind: "section", id: first.id } : { kind: "theme" };
  });
  const [tab, setTab] = useState<"sections" | "site">("sections");
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [view, setView] = useState<"edit" | "preview">("edit");
  const [addType, setAddType] = useState<SectionType>("about");
  const [live, setLive] = useState("");
  const [status, setStatus] = useState(initial.status);
  const [slug, setSlug] = useState(initial.slug);
  const [versions, setVersions] = useState<VersionLite[]>(initial.versions);
  const [publishing, setPublishing] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: "success" | "info" | "danger"; text: string; link?: string } | null>(null);

  // ---- autosave with optimistic concurrency -------------------------------------------------
  const [saved, setSaved] = useState<{ doc: StorefrontDocument; at: string | null }>({ doc: initial.document, at: null });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ msg: string; conflict: boolean } | null>(null);
  const etagRef = useRef(initial.etag);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const validation = useMemo(() => validateDocument(doc), [doc]);
  const dirty = doc !== saved.doc;

  const doSave = useCallback((snapshot: StorefrontDocument, force = false): Promise<boolean> => {
    const run = async () => {
      setSaving(true);
      const r = await saveDraftAction(snapshot, force ? null : etagRef.current);
      setSaving(false);
      if (r.ok) {
        etagRef.current = r.data.etag;
        setSaved({ doc: snapshot, at: r.data.savedAt });
        setSaveError(null);
        return true;
      }
      setSaveError({ msg: r.error, conflict: /changed elsewhere/i.test(r.error) });
      return false;
    };
    const p = queueRef.current.then(run, run) as Promise<boolean>;
    queueRef.current = p;
    return p;
  }, []);

  const conflict = saveError?.conflict === true;
  useEffect(() => {
    if (!dirty || !validation.ok || conflict) return;
    const t = setTimeout(() => void doSave(doc), 1200);
    return () => clearTimeout(t);
  }, [dirty, validation.ok, conflict, doc, doSave]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const replaceAll = useCallback((document: unknown, etag: string) => {
    const v = validateDocument(document);
    if (!v.ok) return;
    etagRef.current = etag;
    setH((p) => ({ doc: v.document, past: [], future: [], at: 0, reset: p.reset + 1 }));
    setSaved({ doc: v.document, at: new Date().toISOString() });
    setSaveError(null);
    setPageSlug("home");
  }, []);

  // ---- document edits -------------------------------------------------------------------------
  const commit = useCallback((mut: (d: StorefrontDocument) => void) => {
    const now = Date.now();
    setH((p) => {
      const next = structuredClone(p.doc);
      mut(next);
      const merge = now - p.at < 900; // fold rapid typing into one undo step
      return { doc: next, past: merge ? p.past : [...p.past.slice(-49), p.doc], future: [], at: now, reset: p.reset };
    });
  }, []);
  const undo = () => setH((p) => (p.past.length ? { doc: p.past[p.past.length - 1]!, past: p.past.slice(0, -1), future: [p.doc, ...p.future], at: 0, reset: p.reset + 1 } : p));
  const redo = () => setH((p) => (p.future.length ? { doc: p.future[0]!, past: [...p.past, p.doc], future: p.future.slice(1), at: 0, reset: p.reset + 1 } : p));

  const pageIdx = Math.max(0, doc.pages.findIndex((p) => p.slug === pageSlug));
  const page = doc.pages[pageIdx]!;
  const selected = sel?.kind === "section" ? page.sections.find((s) => s.id === sel.id) ?? null : null;

  const patchPage = (fn: (p: Page) => void) => commit((d) => fn(d.pages[pageIdx]!));
  const patchSection = (id: string, patch: Record<string, unknown>) => patchPage((p) => { const s = p.sections.find((x) => x.id === id); if (s) Object.assign(s, patch); });

  const announce = (t: string) => setLive(t);
  const moveSection = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= page.sections.length) return;
    const label = SECTION_LABELS[page.sections[i]!.type];
    patchPage((p) => { [p.sections[i], p.sections[j]] = [p.sections[j]!, p.sections[i]!]; });
    announce(`${label} moved to position ${j + 1} of ${page.sections.length}`);
  };
  const duplicate = (i: number) => {
    const src = page.sections[i]!;
    if (src.type === "trustStrip" || page.sections.length >= LIMITS.sectionsPerPage) return;
    const id = newSectionId(src.type, page.sections.map((s) => s.id));
    patchPage((p) => p.sections.splice(i + 1, 0, { ...structuredClone(src), id }));
    setSel({ kind: "section", id });
    announce(`${SECTION_LABELS[src.type]} duplicated`);
  };
  const remove = (i: number) => {
    const s = page.sections[i]!;
    patchPage((p) => p.sections.splice(i, 1));
    const next = page.sections[i + 1] ?? page.sections[i - 1];
    setSel(next ? { kind: "section", id: next.id } : null);
    announce(`${SECTION_LABELS[s.type]} deleted. Use Undo to bring it back.`);
  };
  const add = () => {
    if (page.sections.length >= LIMITS.sectionsPerPage) return;
    const id = newSectionId(addType, page.sections.map((s) => s.id));
    const at = selected ? page.sections.findIndex((s) => s.id === selected.id) + 1 : page.sections.length;
    patchPage((p) => p.sections.splice(at, 0, defaultSection(addType, id)));
    setSel({ kind: "section", id });
    announce(`${SECTION_LABELS[addType]} added`);
  };

  // ---- publish -------------------------------------------------------------------------------
  const publish = async () => {
    setOutcome(null);
    if (!validation.ok) return setOutcome({ tone: "danger", text: "Fix the highlighted problems before publishing." });
    setPublishing(true);
    try {
      if (dirty && !(await doSave(doc))) return setOutcome({ tone: "danger", text: "Your latest changes could not be saved, so nothing was published." });
      const r = await publishAction();
      if (!r.ok) return setOutcome({ tone: "danger", text: r.error });
      if (r.data.outcome === "published") {
        setStatus("live");
        setOutcome({ tone: "success", text: "Published. Your storefront is live.", link: `${initial.liveBase}/store/${slug}` });
      } else {
        setOutcome({ tone: "info", text: `Sent for review. Our automated checks flagged some content${r.data.flags.length ? ` (${r.data.flags.join(", ")})` : ""}, so a team member will look at it before it goes live. ${status === "live" ? "Your live storefront is unchanged until then." : "Nothing is live yet."} You can keep editing.` });
      }
      const v = await listVersionsAction();
      if (v.ok) setVersions(v.data.map((x) => ({ id: x.id, version: x.version, status: x.status, createdAt: x.createdAt, publishedAt: x.publishedAt, reviewNote: x.reviewNote })));
    } finally {
      setPublishing(false);
    }
  };

  // ---- preview wiring ------------------------------------------------------------------------
  const hrefs = useMemo<RenderHrefs>(() => ({ page: (s) => `#page:${s}`, product: () => "#", rfq: "#" }), []);
  const onPreviewClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[aria-labelledby^='sf-h-'], [id^='sf-']");
    if (!el) return;
    const raw = el.getAttribute("aria-labelledby")?.replace(/^sf-h-/, "") ?? el.id.replace(/^sf-/, "");
    if (page.sections.some((s) => s.id === raw)) { setSel({ kind: "section", id: raw }); setTab("sections"); }
  };

  const issues = validation.ok ? [] : validation.issues;
  const selIssues = selected ? issues.filter((i) => i.path.startsWith(`pages.${pageIdx}.sections.${page.sections.findIndex((s) => s.id === selected.id)}`)) : [];
  const statusText = saving ? "Saving…" : !validation.ok ? `Fix ${issues.length} problem${issues.length === 1 ? "" : "s"} to save` : dirty ? "Unsaved changes" : saved.at ? `Saved ${new Date(saved.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}` : "All changes saved";

  return (
    <PreviewNav.Provider value={setPageSlug}>
      <div className="flex h-[calc(100dvh-3.5rem)] flex-col">
        <div aria-live="polite" role="status" className="sr-only">{live}</div>

        {/* toolbar */}
        <div role="toolbar" aria-label="Editor" className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="font-medium text-ink">Page</span>
            <Select className="h-9 w-40" value={page.slug} onChange={(e) => setPageSlug(e.target.value)}>
              {doc.pages.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
            </Select>
          </label>
          <button type="button" className={toolBtn} onClick={undo} disabled={!h.past.length}><Undo2 className="size-4" aria-hidden /> Undo</button>
          <button type="button" className={toolBtn} onClick={redo} disabled={!h.future.length}><Redo2 className="size-4" aria-hidden /> Redo</button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Badge tone={status === "live" ? "success" : status === "suspended" ? "danger" : "neutral"}>{status === "live" ? "Live" : status === "suspended" ? "Suspended" : "Draft"}</Badge>
            <span role="status" className={cn("flex items-center gap-1 text-sm", validation.ok ? "text-muted" : "font-medium text-danger")}>
              {saving ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : validation.ok && !dirty ? <CheckCircle2 className="size-3.5 text-success" aria-hidden /> : null}{statusText}
            </span>
            <button type="button" className={cn(toolBtn, "lg:hidden")} onClick={() => setView(view === "edit" ? "preview" : "edit")}>{view === "edit" ? <><Eye className="size-4" aria-hidden /> Preview</> : <><Settings2 className="size-4" aria-hidden /> Edit</>}</button>
            <button type="button" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50" onClick={() => void publish()} disabled={publishing || status === "suspended"}>
              {publishing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Rocket className="size-4" aria-hidden />} {publishing ? "Publishing…" : "Publish"}
            </button>
          </div>
        </div>

        {conflict ? (
          <Alert tone="warning" className="rounded-none">
            <span>This storefront was changed somewhere else (another tab or device). </span>
            <button type="button" className="font-semibold underline" onClick={async () => { const r = await reloadDraftAction(); if (r.ok) replaceAll(r.data.document, r.data.etag); }}>Load the latest version</button>
            {" or "}
            <button type="button" className="font-semibold underline" onClick={() => void doSave(doc, true)}>keep my version</button>.
          </Alert>
        ) : saveError ? <Alert tone="danger" className="rounded-none">{saveError.msg} <button type="button" className="font-semibold underline" onClick={() => void doSave(doc)}>Retry now</button></Alert> : null}
        {outcome ? (
          <Alert tone={outcome.tone} className="rounded-none">
            {outcome.text}{" "}
            {outcome.link ? <a href={outcome.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold underline">View live<ExternalLink className="size-3.5" aria-hidden /><span className="sr-only"> (opens in a new tab)</span></a> : null}
            <button type="button" className="ml-3 font-medium underline" onClick={() => setOutcome(null)}>Dismiss</button>
          </Alert>
        ) : null}
        {!validation.ok ? (
          <div role="alert" className="border-b border-line bg-danger/5 px-3 py-2 text-sm text-danger">
            <p className="font-semibold">Changes are not saved until these are fixed:</p>
            <ul className="mt-1 list-disc pl-5">{issues.slice(0, 4).map((i, n) => <li key={n}>{i.message} <span className="text-xs opacity-80">({i.path.replace(/^pages\.(\d+)\.sections\.(\d+)\./, (_, a, b) => `${doc.pages[+a]?.title ?? "page"} › section ${+b + 1} › `)})</span></li>)}{issues.length > 4 ? <li>and {issues.length - 4} more</li> : null}</ul>
          </div>
        ) : null}

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_380px]">
          {/* left: structure */}
          <aside aria-label="Sections and site settings" className={cn("min-h-0 overflow-y-auto border-r border-line bg-surface p-3", view === "edit" ? "block" : "hidden lg:block")}>
            <div role="group" aria-label="Editor area" className="mb-3 flex gap-1 rounded-full border border-line bg-surface p-1">
              <button type="button" aria-pressed={tab === "sections"} className={tabBtn(tab === "sections")} onClick={() => setTab("sections")}><Layers className="size-4" aria-hidden /> Sections</button>
              <button type="button" aria-pressed={tab === "site"} className={tabBtn(tab === "site")} onClick={() => { setTab("site"); if (!sel || sel.kind === "section") setSel({ kind: "theme" }); }}><Globe className="size-4" aria-hidden /> Site</button>
            </div>
            {tab === "sections" ? (
              <>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{page.title} · {page.sections.length} section{page.sections.length === 1 ? "" : "s"}</h2>
                <ol className="space-y-2">
                  {page.sections.map((s, i) => {
                    const on = sel?.kind === "section" && sel.id === s.id;
                    return (
                      <li key={s.id} className={cn("rounded-lg border p-1.5", on ? "border-brand-600 bg-brand-50" : "border-line bg-surface")}>
                        <button
                          type="button"
                          aria-current={on ? "true" : undefined}
                          className="block w-full rounded px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-brand-600"
                          onClick={() => { setSel({ kind: "section", id: s.id }); setView("edit"); }}
                          onKeyDown={(e) => { if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveSection(i, e.key === "ArrowUp" ? -1 : 1); } }}
                          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                        >
                          <span className="block text-sm font-semibold text-ink">{SECTION_LABELS[s.type]}</span>
                          {summaryOf(s) ? <span className="block truncate text-xs text-muted">{summaryOf(s)}</span> : null}
                        </button>
                        <div className="flex gap-1 px-1 pb-0.5">
                          <button type="button" className={iconBtn} aria-label={`Move ${SECTION_LABELS[s.type]} up`} disabled={i === 0} onClick={() => moveSection(i, -1)}><ArrowUp className="size-4" aria-hidden /></button>
                          <button type="button" className={iconBtn} aria-label={`Move ${SECTION_LABELS[s.type]} down`} disabled={i === page.sections.length - 1} onClick={() => moveSection(i, 1)}><ArrowDown className="size-4" aria-hidden /></button>
                          <button type="button" className={iconBtn} aria-label={`Duplicate ${SECTION_LABELS[s.type]}`} disabled={s.type === "trustStrip" || page.sections.length >= LIMITS.sectionsPerPage} onClick={() => duplicate(i)}><Copy className="size-4" aria-hidden /></button>
                          <button type="button" className={cn(iconBtn, "ml-auto text-danger")} aria-label={`Delete ${SECTION_LABELS[s.type]}`} onClick={() => remove(i)}><Trash2 className="size-4" aria-hidden /></button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
                <div className="mt-4 space-y-2 border-t border-line pt-3">
                  <label htmlFor="add-type" className="text-sm font-medium text-ink">Add a section</label>
                  <div className="flex gap-2">
                    <Select id="add-type" value={addType} onChange={(e) => setAddType(e.target.value as SectionType)}>
                      {SECTION_TYPES.map((t) => <option key={t} value={t} disabled={t === "trustStrip" && page.sections.some((s) => s.type === "trustStrip")}>{SECTION_LABELS[t]}</option>)}
                    </Select>
                    <button type="button" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-50" onClick={add} disabled={page.sections.length >= LIMITS.sectionsPerPage}><Plus className="size-4" aria-hidden /> Add</button>
                  </div>
                  <p className="text-xs text-muted">Tip: focus a section and press Alt + Up or Down arrow to move it.</p>
                </div>
              </>
            ) : (
              <ul className="space-y-1.5">
                {([["theme", "Theme and colours", Palette], ["pages", "Pages", FileText], ["seo", "Search listing (SEO)", Globe], ["settings", "Address, preview and history", Settings2]] as const).map(([k, label, Icon]) => (
                  <li key={k}>
                    <button type="button" aria-current={sel?.kind === k ? "true" : undefined} onClick={() => { setSel({ kind: k }); setView("edit"); }} className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600", sel?.kind === k ? "border-brand-600 bg-brand-50 text-brand-700" : "border-line bg-surface text-ink hover:bg-canvas")}>
                      <Icon className="size-4" aria-hidden /> {label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          {/* centre: live preview */}
          <section aria-label="Live preview" className={cn("min-h-0 overflow-y-auto bg-canvas", view === "preview" ? "block" : "hidden lg:block")}>
            <div className="sticky top-0 z-10 flex items-center justify-center gap-2 border-b border-line bg-canvas/95 p-2 backdrop-blur">
              <button type="button" aria-pressed={device === "desktop"} className={cn(toolBtn, device === "desktop" && "border-brand-600 bg-brand-50 text-brand-700")} onClick={() => setDevice("desktop")}><Monitor className="size-4" aria-hidden /> Desktop</button>
              <button type="button" aria-pressed={device === "mobile"} className={cn(toolBtn, device === "mobile" && "border-brand-600 bg-brand-50 text-brand-700")} onClick={() => setDevice("mobile")}><Smartphone className="size-4" aria-hidden /> Mobile</button>
              <span className="hidden text-xs text-muted xl:inline">Click a section to edit it.</span>
            </div>
            <div className="p-3">
              {/* the preview is a click-to-select surface; sections stay reachable by keyboard from the list on the left */}
              <div className={cn("mx-auto overflow-hidden rounded-card border border-line bg-surface shadow-sm", device === "mobile" ? "max-w-[390px]" : "max-w-[1200px]")} onClickCapture={onPreviewClick}>
                <StorefrontView document={validation.ok ? validation.document : doc} pageSlug={page.slug} data={data} hrefs={hrefs} Link={PreviewLink} preview />
              </div>
            </div>
          </section>

          {/* right: inspector */}
          <aside aria-label="Settings" className={cn("min-h-0 overflow-y-auto border-l border-line bg-surface p-4", view === "edit" ? "block" : "hidden lg:block")}>
            {sel?.kind === "section" && selected ? (
              <div className="space-y-4">
                <h2 className="text-base font-bold text-ink">{SECTION_LABELS[selected.type]}</h2>
                {selIssues.length ? <Alert tone="danger"><ul className="list-disc pl-4">{selIssues.map((i, n) => <li key={n}>{i.message}</li>)}</ul></Alert> : null}
                <BlockForm s={selected} set={(patch) => patchSection(selected.id, patch)} images={images} data={data} resetToken={h.reset} />
              </div>
            ) : sel?.kind === "theme" ? (
              <div key={`theme-${h.reset}`}><h2 className="mb-3 text-base font-bold text-ink">Theme and colours</h2><ThemePanel theme={doc.theme} images={images} sellerName={initial.sellerName} onChange={(theme) => commit((d) => { d.theme = theme; })} /></div>
            ) : sel?.kind === "pages" ? (
              <div key={`pages-${h.reset}`}><h2 className="mb-3 text-base font-bold text-ink">Pages</h2><PagesPanel doc={doc} pageSlug={page.slug} onSelect={(s) => setPageSlug(s)} onChange={(pages) => { commit((d) => { d.pages = pages; }); if (!pages.some((p) => p.slug === pageSlug)) setPageSlug(pages[Math.min(pageIdx, pages.length - 1)]!.slug); }} /></div>
            ) : sel?.kind === "seo" ? (
              <div key={`seo-${h.reset}-${page.slug}`}><h2 className="mb-3 text-base font-bold text-ink">Search listing: {page.title}</h2><SeoPanel page={page} storeName={initial.sellerName} address={`${initial.liveBase}/store/${slug}${page.slug === "home" ? "" : `/${page.slug}`}`} onChange={(seo) => patchPage((p) => { p.seo = seo; })} /></div>
            ) : sel?.kind === "settings" ? (
              <div><h2 className="mb-3 text-base font-bold text-ink">Address, preview and history</h2><SettingsPanel doc={doc} slug={slug} status={status} liveBase={initial.liveBase} versions={versions} onRestore={replaceAll} onSlug={setSlug} /></div>
            ) : (
              <p className="text-sm text-muted">Select a section on the left, or click it in the preview, to edit it. Use the Site tab for colours, pages and your address.</p>
            )}
          </aside>
        </div>
      </div>
    </PreviewNav.Provider>
  );
}
