"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Badge, Button, Field, Input, Textarea } from "@cnote/ui";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  discardDraftAction, previewTemplateAction, publishAction, rollbackAction, saveDraftAction, sendTestAction, startDraftAction, type PreviewResult,
} from "./actions";
import { RichEditor, type EditorVariable } from "./rich-editor";
import { PreviewFrame, fmtWhen, useDebouncedCallback } from "./shared";
import { VersionPanel, type VersionItem } from "./version-panel";

export interface EditorVersion {
  id: string;
  version: number;
  status: "draft" | "published" | "archived";
  subject: string | null;
  preheader: string | null;
  body: string;
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface TemplateEditorProps {
  templateId: string;
  channel: "email" | "in_app" | "sms" | "whatsapp";
  variables: (EditorVariable & { example: string; required?: boolean })[];
  versions: EditorVersion[];
  draft: EditorVersion | null;
  published: EditorVersion | null;
  draftToken: string | null;
  canManage: boolean;
  canPublish: boolean;
}

type Save = { state: "idle" | "dirty" | "saving" | "saved" | "error" | "conflict"; at?: string; msg?: string };

const GSM = /^[A-Za-z0-9 \r\n@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/;
function smsStats(text: string) {
  const unicode = !GSM.test(text);
  const len = [...text].length;
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  const segments = len === 0 ? 0 : len <= single ? 1 : Math.ceil(len / multi);
  return { len, segments, unicode, single };
}

const serialize = (v: EditorVersion) => `${v.subject ? `Subject: ${v.subject}\n` : ""}${v.preheader ? `Preheader: ${v.preheader}\n` : ""}\n${v.body}`;

export function TemplateEditor(p: TemplateEditorProps) {
  const router = useRouter();
  const isEmail = p.channel === "email";
  const editing = !!p.draft && p.canManage;
  const base = p.draft ?? p.published;
  const [subject, setSubject] = useState(base?.subject ?? "");
  const [preheader, setPreheader] = useState(base?.preheader ?? "");
  const [body, setBody] = useState(base?.body ?? "");
  const [note, setNote] = useState(p.draft?.changeNote ?? "");
  const [save, setSave] = useState<Save>({ state: "idle" });
  const token = useRef<string | null>(p.draftToken);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [banner, setBanner] = useState<{ tone: "danger" | "success" | "warning"; text: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();
  const lastField = useRef<"subject" | "preheader" | "body">("body");
  const seq = useRef(0);
  const latest = useRef({ subject, preheader, body, note });
  useEffect(() => { latest.current = { subject, preheader, body, note }; });
  const conflict = save.state === "conflict";
  const [epoch, setEpoch] = useState(0);

  // After "Reload their version": adopt the server's draft (new props) and remount the editor with it.
  useEffect(() => {
    if (save.state !== "conflict" || !p.draft || p.draftToken === token.current) return;
    setSubject(p.draft.subject ?? "");
    setPreheader(p.draft.preheader ?? "");
    setBody(p.draft.body);
    setNote(p.draft.changeNote ?? "");
    token.current = p.draftToken;
    setSave({ state: "idle" });
    setEpoch((e) => e + 1);
  }, [p.draft, p.draftToken, save.state]);

  // ----- saving: every save goes through one sequential chain so the conflict token is always current.
  // The server rejects a save when the draft changed since `token` (conflict protection).
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const saveNow = (): Promise<ActionResult<{ token: string; warnings: string[]; savedAt: string }>> => {
    const run = chain.current.then(async () => {
      const cur = latest.current;
      setSave((s) => ({ ...s, state: "saving" }));
      const r = await saveDraftAction(p.templateId, { subject: cur.subject || null, preheader: isEmail ? cur.preheader || null : null, body: cur.body, changeNote: cur.note || null, token: token.current });
      if (r.ok) {
        token.current = r.data.token;
        setWarnings(r.data.warnings);
        setSave({ state: "saved", at: r.data.savedAt });
      } else if (/changed by someone else/i.test(r.error)) setSave({ state: "conflict", msg: r.error });
      else setSave({ state: "error", msg: r.error });
      return r;
    });
    chain.current = run.catch(() => undefined);
    return run;
  };
  const doSave = useDebouncedCallback(() => { if (editing && !conflict) void saveNow(); }, 1500);
  const dirty = () => { setSave((s) => (s.state === "conflict" ? s : { state: "dirty" })); doSave(); };

  // ----- live preview through the real renderer
  const doPreview = useDebouncedCallback(async () => {
    const id = ++seq.current;
    setPreviewing(true);
    const cur = latest.current;
    const r = await previewTemplateAction(p.templateId, { subject: cur.subject || null, preheader: cur.preheader || null, body: cur.body });
    if (id !== seq.current) return;
    setPreviewing(false);
    if (r.ok) { setPreview(r.data); setPreviewErr(null); } else setPreviewErr(r.error);
  }, 700);
  useEffect(() => { doPreview(); }, [subject, preheader, body]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { doPreview.flush(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function run(fn: () => Promise<ActionResult<unknown>>, ok: string, after?: () => void) {
    setBanner(null);
    startTransition(async () => {
      doSave.cancel();
      const r = await fn();
      if (!r.ok) setBanner({ tone: "danger", text: r.error });
      else { setBanner({ tone: "success", text: ok }); after?.(); router.refresh(); }
    });
  }

  function insertVar(name: string) {
    const tag = `{{${name}}}`;
    const target = lastField.current;
    if (target === "body" && !isEmail) {
      const el = document.getElementById("tpl-body") as HTMLTextAreaElement | null;
      const s = el?.selectionStart ?? body.length;
      const e = el?.selectionEnd ?? body.length;
      setBody(body.slice(0, s) + tag + body.slice(e));
      dirty();
      requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(s + tag.length, s + tag.length); });
    } else if (target === "preheader") {
      const el = document.getElementById("tpl-preheader") as HTMLInputElement | null; const s = el?.selectionStart ?? preheader.length; const e = el?.selectionEnd ?? preheader.length;
      setPreheader(preheader.slice(0, s) + tag + preheader.slice(e)); dirty();
    } else {
      const el = document.getElementById("tpl-subject") as HTMLInputElement | null; const s = el?.selectionStart ?? subject.length; const e = el?.selectionEnd ?? subject.length;
      setSubject(subject.slice(0, s) + tag + subject.slice(e)); dirty();
    }
  }

  const draftItem: VersionItem | null = p.draft ? { ...p.draft, content: editing ? serialize({ ...p.draft, subject, preheader, body }) : serialize(p.draft) } : null;
  const items: VersionItem[] = p.versions.map((v) => (draftItem && v.id === draftItem.id ? draftItem : { ...v, content: serialize(v) }));
  const compare = draftItem ?? (p.published ? { ...p.published, content: serialize(p.published) } : null);
  const stats = !isEmail && p.channel === "sms" ? smsStats(body) : null;
  const statusText =
    save.state === "saving" ? "Saving…" : save.state === "dirty" ? "Unsaved changes" : save.state === "saved" ? `Saved ${save.at ? fmtWhen(save.at) : ""}` : save.state === "error" ? `Not saved: ${save.msg}` : save.state === "conflict" ? "Conflict" : editing ? "All changes saved" : "";

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-5">
        {banner ? <Alert tone={banner.tone}>{banner.text}</Alert> : null}
        {conflict ? (
          <Alert tone="danger">
            This draft was changed by someone else since you opened it, so your latest edits were <strong>not</strong> saved.{" "}
            <button type="button" className="font-semibold underline" onClick={() => router.refresh()}>Reload their version</button> (copy your text first if you need it).
          </Alert>
        ) : null}
        {warnings.length ? <Alert tone="warning">Unknown variable(s) will render empty: {warnings.map((w) => `{{${w}}}`).join(", ")}</Alert> : null}

        {!p.draft ? (
          <Alert tone="info">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>You&apos;re viewing the live version{p.published ? ` (v${p.published.version})` : ""}. {p.canManage ? "Create a draft to edit it; nothing goes live until it is published." : "You have read-only access."}</span>
              {p.canManage ? <Button size="sm" disabled={pending} onClick={() => run(() => startDraftAction(p.templateId), "Draft created.")}>Create draft</Button> : null}
            </div>
          </Alert>
        ) : null}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0 space-y-4">
            {p.channel === "email" || p.channel === "in_app" ? (
              <Field label={p.channel === "email" ? "Subject" : "Title"} htmlFor="tpl-subject">
                <Input id="tpl-subject" value={subject} disabled={!editing} maxLength={300} onFocus={() => (lastField.current = "subject")} onChange={(e) => { setSubject(e.target.value); dirty(); }} />
              </Field>
            ) : null}
            {isEmail ? (
              <Field label="Preheader" htmlFor="tpl-preheader" hint="The grey preview text next to the subject in most inboxes.">
                <Input id="tpl-preheader" value={preheader} disabled={!editing} maxLength={300} onFocus={() => (lastField.current = "preheader")} onChange={(e) => { setPreheader(e.target.value); dirty(); }} />
              </Field>
            ) : null}

            {!isEmail && p.variables.length ? (
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Insert variable">
                <span className="text-xs font-medium text-muted">Insert variable:</span>
                {p.variables.map((v) => (
                  <button key={v.name} type="button" title={v.description} disabled={!editing} onMouseDown={(e) => e.preventDefault()} onClick={() => insertVar(v.name)} className="rounded-full border border-line px-2 py-0.5 font-mono text-xs hover:bg-canvas disabled:opacity-50">{`{{${v.name}}}`}</button>
                ))}
              </div>
            ) : null}

            <div className="space-y-1.5" onFocusCapture={() => (lastField.current = "body")}>
              <span className="text-sm font-medium" id="tpl-body-label">{isEmail ? "Message" : p.channel === "sms" ? "SMS text" : p.channel === "whatsapp" ? "WhatsApp text" : "Notification text"}</span>
              {isEmail ? (
                <RichEditor
                  key={`${p.draft?.id ?? p.published?.id ?? "none"}-${epoch}`}
                  label="Email body"
                  value={body}
                  editable={editing}
                  variables={p.variables}
                  onChange={(html) => { setBody(html); dirty(); }}
                />
              ) : (
                <>
                  <Textarea id="tpl-body" aria-labelledby="tpl-body-label" rows={8} value={body} disabled={!editing} onChange={(e) => { setBody(e.target.value); dirty(); }} className="font-mono" />
                  <p className="text-xs text-muted" aria-live="polite">
                    {[...body].length} characters
                    {stats ? ` · ${stats.segments} SMS segment${stats.segments === 1 ? "" : "s"} (${stats.single} per segment${stats.unicode ? ", non-GSM characters present" : ""}). Variables are counted as typed; real values change the length.` : ""}
                  </p>
                </>
              )}
            </div>

            {editing ? (
              <Field label="Change note" htmlFor="tpl-note" hint="Shown in the version history.">
                <Input id="tpl-note" value={note} maxLength={300} onChange={(e) => { setNote(e.target.value); dirty(); }} />
              </Field>
            ) : null}
          </div>

          <div className="min-w-0">
            {isEmail ? (
              <PreviewFrame html={preview?.html ?? null} title="Email preview" loading={previewing} error={previewErr} />
            ) : (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Preview {previewing ? <span className="font-normal text-muted">(updating…)</span> : null}</h3>
                {previewErr ? <Alert tone="danger">{previewErr}</Alert> : null}
                <div className="rounded-lg border border-line bg-canvas p-4 text-sm">
                  {preview?.subject ? <p className="font-semibold">{preview.subject}</p> : null}
                  <p className="whitespace-pre-wrap">{preview?.text}</p>
                </div>
                <p className="text-xs text-muted">Rendered with example values.</p>
              </div>
            )}
            {isEmail && preview ? <p className="mt-2 truncate text-xs text-muted">Subject preview: <span className="font-medium text-ink">{preview.subject}</span></p> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
          {editing ? (
            <>
              <span className="mr-2 text-xs text-muted" aria-live="polite">{statusText}</span>
              <Button variant="outline" disabled={pending || conflict} onClick={() => run(() => saveNow(), "Draft saved.")}>Save draft</Button>
              {isEmail ? <Button variant="outline" disabled={pending || conflict} onClick={() => run(async () => { const r = await saveNow(); return r.ok ? sendTestAction(p.templateId) : r; }, "Test email sent to your own address.")}>Send test to me</Button> : null}
              {p.canPublish ? (
                <Button disabled={pending || conflict || save.state === "error"} onClick={() => { if (window.confirm("Publish this draft? It goes live for all future messages immediately.")) run(async () => { const r = await saveNow(); return r.ok ? publishAction(p.templateId, p.draft!.id) : r; }, "Published."); }}>Publish</Button>
              ) : <Badge tone="neutral">Publishing needs the templates.publish privilege</Badge>}
              <Button variant="ghost" className="text-danger" disabled={pending} onClick={() => { if (window.confirm("Discard this draft? Your unpublished edits are kept only in the version history.")) run(() => discardDraftAction(p.templateId), "Draft discarded."); }}>Discard draft</Button>
            </>
          ) : isEmail && p.canManage && p.published ? (
            <Button variant="outline" disabled={pending} onClick={() => run(() => sendTestAction(p.templateId), "Test email sent to your own address.")}>Send test to me</Button>
          ) : null}
        </div>
      </div>

      <aside className="min-w-0">
        <VersionPanel
          versions={items}
          compareWith={compare}
          canManage={p.canManage}
          canPublish={p.canPublish}
          busy={pending}
          onStartFrom={(id) => startDraftAction(p.templateId, id)}
          onRollback={(id) => rollbackAction(p.templateId, id)}
        />
      </aside>
    </div>
  );
}
