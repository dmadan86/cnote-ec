"use server";
import "@/features/templates/registry";
import { audited, requirePrivilege } from "@cnote/admin";
import { redis } from "@cnote/core";
import { sendTestEmail } from "@cnote/email";
import { currentSession, runAction, type ActionResult } from "@cnote/next-kit";
import {
  createTemplateLocale, deleteTemplateAsset, discardDraft, discardLayoutDraft, getLayout, getTemplate, previewEmail, previewLayout, previewText,
  publishDraft, publishLayoutDraft, rollbackLayout, rollbackTemplate, saveDraft, saveLayoutDraft, seedDefaultTemplates, setTemplateEnabled,
  setTemplateLayout, startDraft, startLayoutDraft, type TemplateChannel,
} from "@cnote/templates";
import { DomainError } from "@cnote/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

// Privileges are enforced here on the server for every action (the UI hiding buttons is cosmetic):
//   templates.read → previews · templates.manage → edit/test/upload/toggle · templates.publish → publish/rollback.
const id = z.uuid();
const draftInput = z.object({
  subject: z.string().max(2000).nullable().optional(),
  preheader: z.string().max(2000).nullable().optional(),
  body: z.string().max(300_000),
  changeNote: z.string().max(300).nullable().optional(),
  token: z.string().max(64).nullable().optional(),
});
const layoutInput = z.object({
  headerHtml: z.string().max(100_000),
  footerHtml: z.string().max(100_000),
  theme: z.record(z.string(), z.unknown()),
  token: z.string().max(64).nullable().optional(),
});

const refresh = (templateId?: string) => {
  revalidatePath("/templates");
  if (templateId) revalidatePath(`/templates/${templateId}`);
};

/**
 * Autosave writes a draft every few seconds. Auditing each one would flood the append-only log, so the FIRST save of an
 * editing burst is audited and further saves by the same staff member on the same draft within 5 minutes are not
 * (privilege is still checked; publish/rollback/etc. are always audited).
 */
async function saveAudited<T>(ctx: Awaited<ReturnType<typeof actionContext>>, action: string, subject: { type: string; id: string }, fn: () => Promise<T>): Promise<T> {
  requirePrivilege(ctx.staff, "templates.manage");
  const key = `tpl:autosave-audit:${subject.id}:${ctx.staff.id}`;
  let first = true;
  try {
    first = (await redis.set(key, "1", "EX", 300, "NX")) === "OK";
  } catch {
    first = true;
  }
  return first ? audited(ctx, "templates.manage", action, subject, fn) : fn();
}

// ------------------------------------------------------------------ template list / settings
export async function seedDefaultsAction(): Promise<ActionResult<{ layouts: number; templates: number }>> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    return audited(ctx, "templates.manage", "template.seed_defaults", { type: "template", id: null }, () => seedDefaultTemplates());
  });
  if (r.ok) refresh();
  return r;
}

export async function setEnabledAction(templateId: string, enabled: boolean): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(templateId);
    await audited(ctx, "templates.manage", enabled ? "template.enable" : "template.disable", { type: "template", id: templateId }, () => setTemplateEnabled(templateId, enabled), { enabled });
  });
  if (r.ok) refresh(templateId);
  return r;
}

export async function setLayoutAction(templateId: string, layoutId: string | null): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(templateId);
    if (layoutId) id.parse(layoutId);
    await audited(ctx, "templates.manage", "template.set_layout", { type: "template", id: templateId }, () => setTemplateLayout(templateId, layoutId), { layoutId });
  });
  if (r.ok) refresh(templateId);
  return r;
}

export async function createLocaleAction(key: string, channel: TemplateChannel, locale: string): Promise<ActionResult<{ id: string }>> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    z.string().max(100).parse(key);
    const ch = z.enum(["email", "in_app", "sms", "whatsapp"]).parse(channel);
    const row = await audited(ctx, "templates.manage", "template.create_locale", { type: "template", id: null }, () => createTemplateLocale(key, ch, locale, ctx.staff.id), { key, channel: ch, locale });
    return { id: row.id };
  });
  if (r.ok) refresh();
  return r;
}

// ------------------------------------------------------------------ template drafts
export async function startDraftAction(templateId: string, fromVersionId?: string): Promise<ActionResult<{ versionId: string }>> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(templateId);
    if (fromVersionId) id.parse(fromVersionId);
    const v = await audited(ctx, "templates.manage", "template.draft.start", { type: "template", id: templateId }, () => startDraft(templateId, ctx.staff.id, fromVersionId), { fromVersionId: fromVersionId ?? null });
    return { versionId: v.id };
  });
  if (r.ok) refresh(templateId);
  return r;
}

export async function saveDraftAction(templateId: string, input: z.input<typeof draftInput>): Promise<ActionResult<{ token: string; warnings: string[]; savedAt: string }>> {
  return runAction(async () => {
    const ctx = await actionContext();
    id.parse(templateId);
    const data = draftInput.parse(input);
    const res = await saveAudited(ctx, "template.draft.save", { type: "template", id: templateId }, () => saveDraft(templateId, data));
    return { token: res.token, warnings: res.warnings, savedAt: new Date().toISOString() };
  });
}

export async function discardDraftAction(templateId: string): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(templateId);
    await audited(ctx, "templates.manage", "template.draft.discard", { type: "template", id: templateId }, () => discardDraft(templateId));
  });
  if (r.ok) refresh(templateId);
  return r;
}

export async function publishAction(templateId: string, versionId: string): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(templateId);
    id.parse(versionId);
    await audited(ctx, "templates.publish", "template.publish", { type: "template", id: templateId }, async () => {
      const v = await getTemplate(templateId);
      if (!v?.versions.some((x) => x.id === versionId)) throw new DomainError("not_found", "Version not found.");
      await publishDraft(versionId, ctx.staff.id);
    }, { versionId });
  });
  if (r.ok) refresh(templateId);
  return r;
}

export async function rollbackAction(templateId: string, toVersionId: string): Promise<ActionResult<{ version: number }>> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(templateId);
    id.parse(toVersionId);
    const v = await audited(ctx, "templates.publish", "template.rollback", { type: "template", id: templateId }, () => rollbackTemplate(templateId, toVersionId, ctx.staff.id), { toVersionId });
    return { version: v.version };
  });
  if (r.ok) refresh(templateId);
  return r;
}

// ------------------------------------------------------------------ previews and test sends
export interface PreviewResult {
  subject: string | null;
  preheader: string | null;
  html: string | null;
  text: string;
}

export async function previewTemplateAction(templateId: string, input: { subject: string | null; preheader: string | null; body: string; layoutId?: string | null }): Promise<ActionResult<PreviewResult>> {
  return runAction(async () => {
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "templates.read");
    id.parse(templateId);
    const t = await getTemplate(templateId);
    if (!t) throw new DomainError("not_found", "Template not found.");
    if (t.template.channel === "email") {
      const layoutVersionId = t.template.layoutId ? (await getLayout(t.template.layoutId))?.published?.id : undefined;
      const r = await previewEmail({ key: t.template.key, subject: input.subject, preheader: input.preheader, body: input.body, layout: layoutVersionId ? { layoutVersionId } : { layoutKey: "default" } });
      return { subject: r.subject, preheader: r.preheader, html: r.html, text: r.text };
    }
    const r = await previewText({ key: t.template.key, channel: t.template.channel, title: input.subject, body: input.body });
    return { subject: r.title, preheader: null, html: null, text: r.body };
  });
}

/** Sends the open draft (else the published version) to the signed-in staff member's own address. The client saves first. */
export async function sendTestAction(templateId: string): Promise<ActionResult<{ to: string; provider: string }>> {
  return runAction(async () => {
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "templates.manage");
    id.parse(templateId);
    const session = await currentSession();
    const to = session?.email;
    if (!to) throw new DomainError("validation", "Your account has no email address to send the test to.");
    const t = await getTemplate(templateId);
    if (!t) throw new DomainError("not_found", "Template not found.");
    if (t.template.channel !== "email") throw new DomainError("validation", "Test sends are available for email templates only.");
    const version = t.draft ?? t.published;
    if (!version) throw new DomainError("validation", "There is nothing to send yet.");
    const res = await audited(ctx, "templates.manage", "template.send_test", { type: "template", id: templateId }, () => sendTestEmail(t.template.key, to, {}, { versionId: version.id }), { versionId: version.id });
    return { to, provider: res.provider };
  });
}

// ------------------------------------------------------------------ layouts
export async function startLayoutDraftAction(layoutId: string, fromVersionId?: string): Promise<ActionResult<{ versionId: string }>> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(layoutId);
    const v = await audited(ctx, "templates.manage", "layout.draft.start", { type: "layout", id: layoutId }, () => startLayoutDraft(layoutId, ctx.staff.id, fromVersionId), { fromVersionId: fromVersionId ?? null });
    return { versionId: v.id };
  });
  if (r.ok) revalidatePath(`/templates/layouts/${layoutId}`);
  return r;
}

export async function saveLayoutDraftAction(layoutId: string, input: z.input<typeof layoutInput>): Promise<ActionResult<{ token: string; savedAt: string }>> {
  return runAction(async () => {
    const ctx = await actionContext();
    id.parse(layoutId);
    const data = layoutInput.parse(input);
    const res = await saveAudited(ctx, "layout.draft.save", { type: "layout", id: layoutId }, () => saveLayoutDraft(layoutId, data));
    return { token: res.token, savedAt: new Date().toISOString() };
  });
}

export async function discardLayoutDraftAction(layoutId: string): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(layoutId);
    await audited(ctx, "templates.manage", "layout.draft.discard", { type: "layout", id: layoutId }, () => discardLayoutDraft(layoutId));
  });
  if (r.ok) revalidatePath(`/templates/layouts/${layoutId}`);
  return r;
}

export async function publishLayoutAction(layoutId: string, versionId: string): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(layoutId);
    id.parse(versionId);
    await audited(ctx, "templates.publish", "layout.publish", { type: "layout", id: layoutId }, async () => {
      const l = await getLayout(layoutId);
      if (!l?.versions.some((x) => x.id === versionId)) throw new DomainError("not_found", "Version not found.");
      await publishLayoutDraft(versionId, ctx.staff.id);
    }, { versionId });
  });
  if (r.ok) revalidatePath(`/templates/layouts/${layoutId}`);
  return r;
}

export async function rollbackLayoutAction(layoutId: string, toVersionId: string): Promise<ActionResult<{ version: number }>> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(layoutId);
    id.parse(toVersionId);
    const v = await audited(ctx, "templates.publish", "layout.rollback", { type: "layout", id: layoutId }, () => rollbackLayout(layoutId, toVersionId, ctx.staff.id), { toVersionId });
    return { version: v.version };
  });
  if (r.ok) revalidatePath(`/templates/layouts/${layoutId}`);
  return r;
}

export async function previewLayoutAction(input: { headerHtml: string; footerHtml: string; theme: Record<string, unknown>; marketing?: boolean }): Promise<ActionResult<{ html: string }>> {
  return runAction(async () => {
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "templates.read");
    const r = await previewLayout({ headerHtml: input.headerHtml.slice(0, 100_000), footerHtml: input.footerHtml.slice(0, 100_000), theme: input.theme, category: input.marketing ? "marketing" : "transactional" });
    return { html: r.html };
  });
}

// ------------------------------------------------------------------ assets
export async function deleteAssetAction(assetId: string): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    id.parse(assetId);
    await audited(ctx, "templates.manage", "template.asset.delete", { type: "template_asset", id: assetId }, () => deleteTemplateAsset(assetId));
  });
  if (r.ok) refresh();
  return r;
}
