"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Field, Select } from "@cnote/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { discardLayoutDraftAction, previewLayoutAction, publishLayoutAction, rollbackLayoutAction, saveLayoutDraftAction, startLayoutDraftAction } from "./actions";
import { RichEditor, type EditorVariable } from "./rich-editor";
import { PreviewFrame, fmtWhen, useDebouncedCallback } from "./shared";
import { VersionPanel, type VersionItem } from "./version-panel";

export type Theme = {
  primaryColor: string;
  accentColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  logoAssetId: string | null;
};
export interface LayoutEditorVersion {
  id: string;
  version: number;
  status: "draft" | "published" | "archived";
  headerHtml: string;
  footerHtml: string;
  theme: Theme;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
}

const VARS: EditorVariable[] = [
  { name: "brand.name", description: "Company name" },
  { name: "brand.address", description: "Company address" },
  { name: "brand.supportEmail", description: "Support email address" },
  { name: "brand.primaryColor", description: "Theme primary colour" },
  { name: "whyReceiving", description: '"Why am I receiving this?" text for the message category' },
  { name: "unsubscribeUrl", description: "Unsubscribe link (marketing emails only)" },
  { name: "year", description: "Current year" },
];

type Save = { state: "idle" | "dirty" | "saving" | "saved" | "error" | "conflict"; at?: string; msg?: string };
const serialize = (v: { headerHtml: string; footerHtml: string; theme: Theme }) => `HEADER\n${v.headerHtml}\n\nFOOTER\n${v.footerHtml}\n\nTHEME\n${JSON.stringify(v.theme, null, 1).replace(/,\n/g, ",\n")}`;

function ColorField({ id, label, value, onChange, disabled }: { id: string; label: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      <div className="flex items-center gap-2">
        <input id={id} type="color" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} className="size-10 cursor-pointer rounded-lg border border-line bg-surface p-1 disabled:opacity-50" />
        <code className="text-xs text-muted">{value}</code>
      </div>
    </div>
  );
}

export function LayoutEditor(p: {
  layoutId: string;
  versions: LayoutEditorVersion[];
  draft: LayoutEditorVersion | null;
  published: LayoutEditorVersion | null;
  draftToken: string | null;
  fonts: Record<string, string>;
  canManage: boolean;
  canPublish: boolean;
}) {
  const router = useRouter();
  const editing = !!p.draft && p.canManage;
  const base = p.draft ?? p.published;
  const [header, setHeader] = useState(base?.headerHtml ?? "");
  const [footer, setFooter] = useState(base?.footerHtml ?? "");
  const [theme, setTheme] = useState<Theme>(base?.theme ?? { primaryColor: "#5b2fd6", accentColor: "#f97316", backgroundColor: "#f8f9fc", textColor: "#111827", fontFamily: Object.values(p.fonts)[0]!, logoAssetId: null });
  const [marketing, setMarketing] = useState(false);
  const [save, setSave] = useState<Save>({ state: "idle" });
  const [banner, setBanner] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [epoch, setEpoch] = useState(0);
  const token = useRef<string | null>(p.draftToken);
  const latest = useRef({ header, footer, theme });
  useEffect(() => { latest.current = { header, footer, theme }; });
  const seq = useRef(0);
  const conflict = save.state === "conflict";

  useEffect(() => {
    if (save.state !== "conflict" || !p.draft || p.draftToken === token.current) return;
    setHeader(p.draft.headerHtml); setFooter(p.draft.footerHtml); setTheme(p.draft.theme);
    token.current = p.draftToken;
    setSave({ state: "idle" });
    setEpoch((e) => e + 1);
  }, [p.draft, p.draftToken, save.state]);

  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const saveNow = (): Promise<ActionResult<{ token: string; savedAt: string }>> => {
    const run = chain.current.then(async () => {
      const cur = latest.current;
      setSave((s) => ({ ...s, state: "saving" }));
      const r = await saveLayoutDraftAction(p.layoutId, { headerHtml: cur.header, footerHtml: cur.footer, theme: cur.theme, token: token.current });
      if (r.ok) { token.current = r.data.token; setSave({ state: "saved", at: r.data.savedAt }); }
      else if (/changed by someone else/i.test(r.error)) setSave({ state: "conflict", msg: r.error });
      else setSave({ state: "error", msg: r.error });
      return r;
    });
    chain.current = run.catch(() => undefined);
    return run;
  };
  const doSave = useDebouncedCallback(() => { if (editing && !conflict) void saveNow(); }, 1500);
  const dirty = () => { setSave((s) => (s.state === "conflict" ? s : { state: "dirty" })); doSave(); };

  const doPreview = useDebouncedCallback(async () => {
    const id = ++seq.current;
    setPreviewing(true);
    const cur = latest.current;
    const r = await previewLayoutAction({ headerHtml: cur.header, footerHtml: cur.footer, theme: cur.theme, marketing });
    if (id !== seq.current) return;
    setPreviewing(false);
    if (r.ok) { setHtml(r.data.html); setPreviewErr(null); } else setPreviewErr(r.error);
  }, 700);
  useEffect(() => { doPreview(); }, [header, footer, theme, marketing]); // eslint-disable-line react-hooks/exhaustive-deps

  function run(fn: () => Promise<ActionResult<unknown>>, ok: string) {
    setBanner(null);
    startTransition(async () => {
      doSave.cancel();
      const r = await fn();
      if (!r.ok) setBanner({ tone: "danger", text: r.error });
      else { setBanner({ tone: "success", text: ok }); router.refresh(); }
    });
  }
  const set = <K extends keyof Theme>(k: K, v: Theme[K]) => { setTheme((t) => ({ ...t, [k]: v })); dirty(); };

  async function uploadLogo(file: File) {
    setLogoErr(null);
    const fd = new FormData();
    fd.set("file", file);
    fd.set("alt", "Logo");
    const res = await fetch("/templates/assets", { method: "POST", body: fd }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as { id?: string; error?: string } | undefined;
    if (!res?.ok || !data?.id) return setLogoErr(data?.error ?? "Upload failed.");
    set("logoAssetId", data.id);
  }

  const draftItem: VersionItem | null = p.draft ? { ...p.draft, changeNote: null, content: serialize(editing ? { headerHtml: header, footerHtml: footer, theme } : p.draft) } : null;
  const items: VersionItem[] = p.versions.map((v) => (draftItem && v.id === draftItem.id ? draftItem : { ...v, changeNote: null, content: serialize(v) }));
  const compare = draftItem ?? (p.published ? { ...p.published, changeNote: null, content: serialize(p.published) } : null);
  const statusText = save.state === "saving" ? "Saving…" : save.state === "dirty" ? "Unsaved changes" : save.state === "saved" ? `Saved ${save.at ? fmtWhen(save.at) : ""}` : save.state === "error" ? `Not saved: ${save.msg}` : editing ? "All changes saved" : "";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-5">
        {banner ? <Alert tone={banner.tone}>{banner.text}</Alert> : null}
        {conflict ? (
          <Alert tone="danger">
            This draft was changed by someone else since you opened it, so your latest edits were <strong>not</strong> saved.{" "}
            <button type="button" className="font-semibold underline" onClick={() => router.refresh()}>Reload their version</button>.
          </Alert>
        ) : null}
        {!p.draft ? (
          <Alert tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>You&apos;re viewing the live layout{p.published ? ` (v${p.published.version})` : ""}. {p.canManage ? "Create a draft to edit it." : "You have read-only access."}</span>
              {p.canManage ? <Button size="sm" disabled={pending} onClick={() => run(() => startLayoutDraftAction(p.layoutId), "Draft created.")}>Create draft</Button> : null}
            </div>
          </Alert>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-5">
            <fieldset disabled={!editing} className="space-y-3">
              <legend className="text-sm font-semibold">Theme</legend>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <ColorField id="th-primary" label="Primary" value={theme.primaryColor} disabled={!editing} onChange={(v) => set("primaryColor", v)} />
                <ColorField id="th-accent" label="Accent" value={theme.accentColor} disabled={!editing} onChange={(v) => set("accentColor", v)} />
                <ColorField id="th-bg" label="Background" value={theme.backgroundColor} disabled={!editing} onChange={(v) => set("backgroundColor", v)} />
                <ColorField id="th-text" label="Text" value={theme.textColor} disabled={!editing} onChange={(v) => set("textColor", v)} />
              </div>
              <Field label="Font" htmlFor="th-font">
                <Select id="th-font" value={theme.fontFamily} onChange={(e) => set("fontFamily", e.target.value)}>
                  {Object.entries(p.fonts).map(([name, stack]) => <option key={name} value={stack}>{name}</option>)}
                </Select>
              </Field>
              <div className="space-y-1.5">
                <span className="text-sm font-medium">Logo</span>
                <div className="flex flex-wrap items-center gap-3">
                  {theme.logoAssetId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`/media/template-assets/${theme.logoAssetId}`} alt="Current logo" className="h-10 max-w-40 rounded border border-line bg-white object-contain p-1" />
                  ) : <span className="text-xs text-muted">No logo (the header text is used).</span>}
                  <label className="inline-flex h-8 cursor-pointer items-center rounded-full border border-line px-3 text-xs font-semibold hover:bg-canvas focus-within:outline-2 focus-within:outline-brand-600">
                    {theme.logoAssetId ? "Replace logo" : "Upload logo"}
                    <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadLogo(f); }} />
                  </label>
                  {theme.logoAssetId ? <Button size="sm" variant="ghost" onClick={() => set("logoAssetId", null)}>Remove</Button> : null}
                </div>
                {logoErr ? <p role="alert" className="text-xs text-danger">{logoErr}</p> : <p className="text-xs text-muted">JPEG, PNG, WebP or GIF, up to 2 MB. Shown above the header.</p>}
              </div>
            </fieldset>

            <div className="space-y-1.5">
              <span className="text-sm font-medium">Header</span>
              <RichEditor key={`h-${p.draft?.id ?? p.published?.id}-${epoch}`} label="Layout header" value={header} editable={editing} variables={VARS} onChange={(h) => { setHeader(h); dirty(); }} />
            </div>
            <div className="space-y-1.5">
              <span className="text-sm font-medium">Footer</span>
              <RichEditor key={`f-${p.draft?.id ?? p.published?.id}-${epoch}`} label="Layout footer" value={footer} editable={editing} variables={VARS} onChange={(h) => { setFooter(h); dirty(); }} />
            </div>
          </div>

          <div className="min-w-0 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="size-4 accent-brand-600" /> Preview as a marketing email (shows unsubscribe link)
            </label>
            <PreviewFrame html={html} title="Layout preview with a sample body" loading={previewing} error={previewErr} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {editing ? (
            <>
              <span className="mr-2 text-xs text-muted" aria-live="polite">{statusText}</span>
              <Button variant="outline" disabled={pending || conflict} onClick={() => run(() => saveNow(), "Draft saved.")}>Save draft</Button>
              {p.canPublish ? (
                <Button disabled={pending || conflict || save.state === "error"} onClick={() => { if (window.confirm("Publish this layout? It changes every email that uses it, immediately.")) run(async () => { const r = await saveNow(); return r.ok ? publishLayoutAction(p.layoutId, p.draft!.id) : r; }, "Published."); }}>Publish</Button>
              ) : null}
              <Button variant="ghost" className="text-danger" disabled={pending} onClick={() => { if (window.confirm("Discard this draft?")) run(() => discardLayoutDraftAction(p.layoutId), "Draft discarded."); }}>Discard draft</Button>
            </>
          ) : null}
        </div>
      </div>
      <aside className="min-w-0">
        <VersionPanel versions={items} compareWith={compare} canManage={p.canManage} canPublish={p.canPublish} busy={pending} onStartFrom={(id) => startLayoutDraftAction(p.layoutId, id)} onRollback={(id) => rollbackLayoutAction(p.layoutId, id)} />
      </aside>
    </div>
  );
}
