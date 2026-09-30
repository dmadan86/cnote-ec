import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { DEFAULT_LAYOUT, assembleEmailHtml, buildView, checkRequired, parseTheme, renderMustache } from "./assemble";
import { resolveAssetUrls } from "./assets";
import { PTR_TTL, VERSION_TTL, layoutPtrKey, layoutVersionKey, softCached, tplPtrKey, tplVersionKey } from "./cache";
import { exampleVars, getTemplateDefinition } from "./registry";
import { htmlToText, sanitizeEmailHtml } from "./sanitize";
import type { LayoutTheme, RenderedEmail, RenderedText, TemplateChannel, TemplateDefinition } from "./types";

interface Content {
  subject: string | null;
  preheader: string | null;
  body: string;
}
interface LayoutContent {
  headerHtml: string;
  footerHtml: string;
  theme: LayoutTheme;
}
interface Ptr {
  templateId: string;
  versionId: string;
  layoutKey: string;
  enabled: boolean;
}

const locales = (locale?: string) => [...new Set([locale?.trim().toLowerCase() || "en", "en"])];

async function pointer(key: string, channel: TemplateChannel, locale: string): Promise<Ptr | null> {
  return softCached(tplPtrKey(key, channel, locale), PTR_TTL, async () => {
    const t = await prisma.messageTemplate.findUnique({ where: { key_channel_locale: { key, channel, locale } }, include: { layout: { select: { key: true } } } });
    if (!t || !t.publishedVersionId) return null;
    return { templateId: t.id, versionId: t.publishedVersionId, layoutKey: t.layout?.key ?? "default", enabled: t.enabled };
  });
}

async function versionContent(versionId: string): Promise<Content> {
  return softCached(tplVersionKey(versionId), VERSION_TTL, async () => {
    const v = await prisma.messageTemplateVersion.findUniqueOrThrow({ where: { id: versionId } });
    return { subject: v.subject, preheader: v.preheader, body: v.body };
  });
}

async function layoutContent(layoutKey: string): Promise<{ id: string | null; content: LayoutContent }> {
  const ptr = await softCached(layoutPtrKey(layoutKey), PTR_TTL, async () => {
    const l = await prisma.messageLayout.findUnique({ where: { key: layoutKey }, select: { publishedVersionId: true } });
    return { versionId: l?.publishedVersionId ?? null };
  });
  if (!ptr.versionId && layoutKey !== "default") return layoutContent("default");
  if (!ptr.versionId) return { id: null, content: DEFAULT_LAYOUT };
  const versionId = ptr.versionId;
  const content = await softCached(layoutVersionKey(versionId), VERSION_TTL, async () => {
    const v = await prisma.messageLayoutVersion.findUniqueOrThrow({ where: { id: versionId } });
    return { headerHtml: v.headerHtml, footerHtml: v.footerHtml, theme: parseTheme(v.theme) } satisfies LayoutContent;
  });
  return { id: versionId, content };
}

async function explicitLayout(layoutVersionId: string): Promise<LayoutContent> {
  const v = await prisma.messageLayoutVersion.findUnique({ where: { id: layoutVersionId } });
  if (!v) throw new DomainError("not_found", "Layout version not found.");
  return { headerHtml: v.headerHtml, footerHtml: v.footerHtml, theme: parseTheme(v.theme) };
}

interface Resolved {
  content: Content;
  versionId: string | null;
  layoutKey: string;
  enabled: boolean;
}

/** locale → en → code default. */
async function resolve(key: string, channel: TemplateChannel, locale: string | undefined, def: TemplateDefinition | undefined, versionId?: string): Promise<Resolved | null> {
  if (versionId) {
    const v = await prisma.messageTemplateVersion.findUnique({ where: { id: versionId }, include: { template: { include: { layout: { select: { key: true } } } } } });
    if (!v || v.template.key !== key || v.template.channel !== channel) throw new DomainError("not_found", "Template version not found.");
    return { content: { subject: v.subject, preheader: v.preheader, body: v.body }, versionId: v.id, layoutKey: v.template.layout?.key ?? "default", enabled: true };
  }
  for (const loc of locales(locale)) {
    const p = await pointer(key, channel, loc);
    if (p) return { content: await versionContent(p.versionId), versionId: p.versionId, layoutKey: p.layoutKey, enabled: p.enabled };
  }
  const loc0 = locale?.trim().toLowerCase();
  const d = (loc0 && def?.localized?.[loc0]?.[channel]) || def?.defaults[channel];
  return d ? { content: { subject: d.subject ?? null, preheader: d.preheader ?? null, body: d.body }, versionId: null, layoutKey: "default", enabled: true } : null;
}

export interface RenderEmailOptions {
  locale?: string;
  /** render this exact version (e.g. an unpublished draft for "send test") */
  versionId?: string;
  layoutVersionId?: string;
  /** "inline" embeds template images as data: URIs (admin preview). Default "absolute" (APP_URL). */
  assets?: "absolute" | "inline";
}

/** Shared pipeline: variables → escaped Mustache → sanitise → table layout → inline CSS → text alternative. */
export async function renderEmailContent(
  def: TemplateDefinition | undefined,
  content: Content,
  layout: LayoutContent,
  vars: Record<string, unknown>,
  ids: { templateVersionId: string | null; layoutVersionId: string | null },
  assets: "absolute" | "inline" = "absolute",
): Promise<RenderedEmail> {
  checkRequired(def, vars);
  const view = buildView(vars, def?.category ?? "transactional", layout.theme);
  const one = (s: string | null | undefined) => (s ? renderMustache(s, view, false).replace(/\s+/g, " ").trim() : "");
  const subject = one(content.subject) || def?.name || "Notification";
  const preheader = one(content.preheader) || null;
  const part = (s: string) => sanitizeEmailHtml(renderMustache(s, view, true));
  const bodyHtml = part(content.body);
  const headerHtml = part(layout.headerHtml);
  const footerHtml = part(layout.footerHtml);
  const html = await resolveAssetUrls(assembleEmailHtml({ subject, preheader, bodyHtml, headerHtml, footerHtml, theme: layout.theme }), assets);
  const text = `${htmlToText(bodyHtml)}\n\n--\n${htmlToText(footerHtml)}`.trim();
  return { subject, preheader, html, text, templateVersionId: ids.templateVersionId, layoutVersionId: ids.layoutVersionId };
}

/**
 * Render the PUBLISHED email version for key+locale (fallback: "en", then code defaults).
 * Throws DomainError("validation") when a required variable is missing.
 */
export async function renderEmail(key: string, vars: Record<string, unknown>, opts: RenderEmailOptions = {}): Promise<RenderedEmail> {
  const def = getTemplateDefinition(key);
  const r = await resolve(key, "email", opts.locale, def, opts.versionId);
  if (!r) throw new DomainError("not_found", `No email content for template "${key}".`);
  let layout: { id: string | null; content: LayoutContent };
  if (opts.layoutVersionId) layout = { id: opts.layoutVersionId, content: await explicitLayout(opts.layoutVersionId) };
  else layout = await layoutContent(r.layoutKey);
  return renderEmailContent(def, r.content, layout.content, vars, { templateVersionId: r.versionId, layoutVersionId: layout.id }, opts.assets);
}

/** Live preview for the editor: unsaved content + optional unsaved layout, definition's example variables by default. */
export async function previewEmail(input: {
  key: string;
  subject: string | null;
  preheader: string | null;
  body: string;
  layout?: { headerHtml: string; footerHtml: string; theme: unknown } | { layoutVersionId: string } | { layoutKey: string };
  vars?: Record<string, unknown>;
}): Promise<RenderedEmail> {
  const def = getTemplateDefinition(input.key);
  const vars = { ...(def ? exampleVars(def) : {}), ...input.vars };
  let layout: LayoutContent;
  const l = input.layout;
  if (l && "headerHtml" in l) layout = { headerHtml: l.headerHtml, footerHtml: l.footerHtml, theme: parseTheme(l.theme) };
  else if (l && "layoutVersionId" in l) layout = await explicitLayout(l.layoutVersionId);
  else layout = (await layoutContent(l && "layoutKey" in l ? l.layoutKey : "default")).content;
  return renderEmailContent(def, { subject: input.subject, preheader: input.preheader, body: input.body }, layout, vars, { templateVersionId: null, layoutVersionId: null }, "inline");
}

/** Render a layout with a sample body (layout editor preview). */
export async function previewLayout(input: { headerHtml: string; footerHtml: string; theme: unknown; category?: "transactional" | "security" | "marketing" }): Promise<RenderedEmail> {
  const def: TemplateDefinition = {
    key: "system.layout_preview", name: "Layout preview", description: "", category: input.category ?? "transactional", channels: ["email"], variables: [],
    defaults: {},
  };
  const body =
    "<h2>Sample heading</h2><p>Hello Asha, this is how body content looks inside your layout. <a href=\"https://example.com\">A sample link</a>.</p><ul><li>First point</li><li>Second point</li></ul><p><strong>Thanks,</strong><br>The team</p>";
  return renderEmailContent(def, { subject: "Layout preview", preheader: "Preview text", body }, { headerHtml: input.headerHtml, footerHtml: input.footerHtml, theme: parseTheme(input.theme) }, {}, { templateVersionId: null, layoutVersionId: null }, "inline");
}

/** Render in_app / sms / whatsapp text (plain, no HTML). */
export async function renderText(key: string, channel: Exclude<TemplateChannel, "email">, vars: Record<string, unknown>, opts: { locale?: string; versionId?: string } = {}): Promise<RenderedText> {
  const def = getTemplateDefinition(key);
  const r = await resolve(key, channel, opts.locale, def, opts.versionId);
  if (!r) throw new DomainError("not_found", `No ${channel} content for template "${key}".`);
  checkRequired(def, vars);
  const view = buildView(vars, def?.category ?? "transactional", parseTheme({}));
  const title = r.content.subject ? renderMustache(r.content.subject, view, false).replace(/\s+/g, " ").trim() || null : null;
  return { title, body: renderMustache(r.content.body, view, false).trim(), templateVersionId: r.versionId };
}

/** Whether a published, enabled template exists for this key+channel (else the channel is skipped). */
export async function isChannelEnabled(key: string, channel: TemplateChannel, locale?: string): Promise<boolean> {
  const def = getTemplateDefinition(key);
  const r = await resolve(key, channel, locale, def);
  return !!r && r.enabled;
}

/** Live preview for text channels from unsaved content, using the definition's example variables. */
export async function previewText(input: { key: string; channel: Exclude<TemplateChannel, "email">; title: string | null; body: string; vars?: Record<string, unknown> }): Promise<RenderedText> {
  const def = getTemplateDefinition(input.key);
  const vars = { ...(def ? exampleVars(def) : {}), ...input.vars };
  checkRequired(def, vars);
  const view = buildView(vars, def?.category ?? "transactional", parseTheme({}));
  const title = input.title ? renderMustache(input.title, view, false).replace(/\s+/g, " ").trim() || null : null;
  return { title, body: renderMustache(input.body, view, false).trim(), templateVersionId: null };
}
