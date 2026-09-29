"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Input, Textarea } from "@cnote/ui";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition } from "react";
import { StorefrontView, type RenderHrefs } from "@cnote/storefront/render";
import { validateDocument } from "@cnote/storefront/document";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { reinstateAction, reorderTemplatesAction, reviewVersionAction, saveTemplateAction, seedTemplatesAction, setTemplateActiveAction, suspendAction, type TemplateSaveResult } from "./actions";
import { SAMPLE_DATA } from "./sample-data";

export function ReviewForm({ versionId }: { versionId: string }) {
  return (
    <ActionForm action={reviewVersionAction} className="space-y-3" successMessage="Decision recorded.">
      <input type="hidden" name="versionId" value={versionId} />
      <label htmlFor="note" className="block text-sm font-medium text-ink">Note to seller <span className="font-normal text-muted">(required when rejecting)</span></label>
      <Textarea id="note" name="note" rows={3} maxLength={500} />
      <div className="flex gap-2">
        <SubmitButton name="outcome" value="approved">Approve and publish</SubmitButton>
        <SubmitButton name="outcome" value="rejected" variant="danger">Reject</SubmitButton>
      </div>
    </ActionForm>
  );
}

export function SuspendForm({ storefrontId }: { storefrontId: string }) {
  return (
    <ActionForm action={suspendAction} className="flex flex-wrap items-start gap-2" confirm="Suspend this storefront? It disappears from the buyer site immediately." successMessage="Suspended.">
      <input type="hidden" name="storefrontId" value={storefrontId} />
      <Input name="reason" required minLength={3} maxLength={500} placeholder="Reason (shown to the seller)" aria-label="Suspension reason" className="w-64" />
      <SubmitButton size="sm" variant="danger">Suspend</SubmitButton>
    </ActionForm>
  );
}

export function ReinstateForm({ storefrontId }: { storefrontId: string }) {
  return (
    <ActionForm action={reinstateAction} confirm="Reinstate this storefront?" successMessage="Reinstated.">
      <input type="hidden" name="storefrontId" value={storefrontId} />
      <SubmitButton size="sm" variant="outline">Reinstate</SubmitButton>
    </ActionForm>
  );
}

export function SeedTemplatesForm() {
  return (
    <ActionForm action={seedTemplatesAction} className="flex flex-col items-end gap-2" successMessage="Built-in templates are in place.">
      <label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" name="overwrite" className="size-4 accent-brand-600" /> Overwrite my edits to built-in templates</label>
      <SubmitButton size="sm" variant="outline">Seed built-in templates</SubmitButton>
    </ActionForm>
  );
}

export function TemplateRowControls({ tplKey, active, index, keys }: { tplKey: string; active: boolean; index: number; keys: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const run = (fn: () => Promise<ActionResult>) => start(async () => { const r = await fn(); if (!r.ok) setErr(r.error); else { setErr(null); router.refresh(); } });
  const move = (d: -1 | 1) => { const next = [...keys]; const j = index + d; if (j < 0 || j >= next.length) return; [next[index], next[j]] = [next[j]!, next[index]!]; run(() => reorderTemplatesAction(next)); };
  return (
    <div className="flex items-center gap-2">
      <label className="inline-flex items-center gap-2 text-xs">
        <input type="checkbox" role="switch" className="size-4 accent-brand-600" checked={active} disabled={pending} aria-label={`${tplKey} active`} onChange={(e) => run(() => setTemplateActiveAction(tplKey, e.target.checked))} />
        {active ? "Active" : "Inactive"}
      </label>
      <Button size="sm" variant="outline" disabled={pending || index === 0} onClick={() => move(-1)} aria-label={`Move ${tplKey} up`}>Up</Button>
      <Button size="sm" variant="outline" disabled={pending || index === keys.length - 1} onClick={() => move(1)} aria-label={`Move ${tplKey} down`}>Down</Button>
      {err ? <span role="alert" className="text-xs text-danger">{err}</span> : null}
    </div>
  );
}

const hrefs: RenderHrefs = { page: () => "#", product: () => "#", rfq: "#" };

export function TemplateEditor({ initial }: { initial: { key: string; name: string; description: string; verticals: string; tags: string; sortOrder: number; active: boolean; document: string; isNew: boolean } }) {
  const [state, action, pending] = useActionState<ActionResult<TemplateSaveResult> | null, FormData>(saveTemplateAction, null);
  const [json, setJson] = useState(initial.document);
  const [pageSlug, setPageSlug] = useState("home");
  let parsed: unknown;
  let parseError: string | null = null;
  try { parsed = JSON.parse(json); } catch (e) { parseError = e instanceof Error ? e.message : "Invalid JSON"; }
  const v = parseError ? null : validateDocument(parsed);
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <form action={action} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">Key<Input name="key" defaultValue={initial.key} readOnly={!initial.isNew} required pattern="[a-z0-9][a-z0-9-]{1,39}" className="mt-1 font-mono" /></label>
          <label className="text-sm font-medium">Name<Input name="name" defaultValue={initial.name} required maxLength={60} className="mt-1" /></label>
        </div>
        <label className="block text-sm font-medium">Description<Textarea name="description" defaultValue={initial.description} required maxLength={300} rows={2} className="mt-1" /></label>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-medium">Verticals (comma separated)<Input name="verticals" defaultValue={initial.verticals} className="mt-1" /></label>
          <label className="text-sm font-medium">Tags (comma separated)<Input name="tags" defaultValue={initial.tags} className="mt-1" /></label>
          <label className="text-sm font-medium">Sort order<Input name="sortOrder" type="number" defaultValue={initial.sortOrder} className="mt-1" /></label>
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={initial.active} className="size-4 accent-brand-600" /> Active (visible in the seller gallery)</label>
        <div>
          <label htmlFor="doc" className="text-sm font-medium">Document (StorefrontDocument v1 JSON)</label>
          <Textarea id="doc" name="document" value={json} onChange={(e) => setJson(e.target.value)} rows={26} spellCheck={false} className="mt-1 font-mono text-xs" />
          <p className="mt-1 text-xs text-muted">Use <code>{"{{name}}"}</code> and <code>{"{{city}}"}</code> where the seller&apos;s real details go. Colours must meet WCAG AA; images must be <code>placeholder:&lt;name&gt;</code>.</p>
        </div>
        {parseError ? <Alert tone="danger">JSON error: {parseError}</Alert> : v && !v.ok ? (
          <Alert tone="danger"><p className="font-semibold">Validation problems</p><ul className="mt-1 list-disc pl-5">{v.issues.slice(0, 8).map((i, n) => <li key={n}><code>{i.path || "document"}</code>: {i.message}</li>)}</ul></Alert>
        ) : <Alert tone="success">Valid document.</Alert>}
        {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        {state?.ok ? <Alert tone="success">Saved.</Alert> : null}
        <Button type="submit" disabled={pending || !!parseError || (v ? !v.ok : true)}>{pending ? "Saving…" : "Save template"}</Button>
      </form>
      <section aria-label="Preview" className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Preview</h2>
          {v?.ok ? v.document.pages.map((p) => <Button key={p.slug} size="sm" variant={p.slug === pageSlug ? "primary" : "outline"} onClick={() => setPageSlug(p.slug)}>{p.title}</Button>) : null}
        </div>
        <div className="max-h-[80vh] overflow-auto rounded-card border border-line bg-surface">
          {v?.ok ? <StorefrontView document={v.document} pageSlug={pageSlug} data={SAMPLE_DATA} hrefs={hrefs} preview /> : <p className="p-6 text-sm text-muted">Fix the document to see a preview. Preview uses sample business data; tokens show as typed.</p>}
        </div>
      </section>
    </div>
  );
}
