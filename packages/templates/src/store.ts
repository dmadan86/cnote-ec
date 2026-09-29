import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { createHash } from "node:crypto";
import { DEFAULT_LAYOUT, parseTheme } from "./assemble";
import { bust, layoutPtrKey, tplPtrKey } from "./cache";
import { getTemplateDefinition, listTemplateDefinitions } from "./registry";
import { cleanEmailHtml, cleanPlainText, referencedVariables } from "./sanitize";
import type { LayoutTheme, TemplateChannel, TemplateDefinition } from "./types";

// ---------------------------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------------------------
export type VersionStatus = "draft" | "published" | "archived";

export interface TemplateVersionView {
  id: string;
  version: number;
  status: VersionStatus;
  subject: string | null;
  preheader: string | null;
  body: string;
  changeNote: string | null;
  createdBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
}
export interface TemplateRowView {
  id: string;
  key: string;
  channel: TemplateChannel;
  locale: string;
  name: string;
  description: string | null;
  layoutId: string | null;
  enabled: boolean;
  publishedVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface TemplateDetail {
  template: TemplateRowView;
  definition: TemplateDefinition | null;
  versions: TemplateVersionView[]; // newest first
  published: TemplateVersionView | null;
  draft: TemplateVersionView | null;
  /** opaque token of the draft's content; send it back with saveDraft for conflict protection */
  draftToken: string | null;
}
export interface TemplateListRow extends TemplateRowView {
  publishedVersion: number | null;
  hasDraft: boolean;
  lastEditedAt: string;
}
export interface TemplateListGroup {
  key: string;
  name: string;
  description: string | null;
  category: string | null;
  definition: TemplateDefinition | null;
  rows: TemplateListRow[];
  /** channels the definition declares that have no DB row yet (run seedDefaultTemplates) */
  missingChannels: TemplateChannel[];
}

export interface LayoutVersionView {
  id: string;
  version: number;
  status: VersionStatus;
  headerHtml: string;
  footerHtml: string;
  theme: LayoutTheme;
  createdBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
}
export interface LayoutDetail {
  layout: { id: string; key: string; name: string; publishedVersionId: string | null; updatedAt: string };
  versions: LayoutVersionView[];
  published: LayoutVersionView | null;
  draft: LayoutVersionView | null;
  draftToken: string | null;
}

const iso = (d: Date) => d.toISOString();
const isoN = (d: Date | null) => (d ? d.toISOString() : null);

type TplVerRow = Awaited<ReturnType<typeof prisma.messageTemplateVersion.findFirstOrThrow>>;
const tv = (r: TplVerRow): TemplateVersionView => ({
  id: r.id, version: r.version, status: r.status, subject: r.subject, preheader: r.preheader, body: r.body, changeNote: r.changeNote,
  createdBy: r.createdBy, createdAt: iso(r.createdAt), publishedBy: r.publishedBy, publishedAt: isoN(r.publishedAt),
});
type LayVerRow = Awaited<ReturnType<typeof prisma.messageLayoutVersion.findFirstOrThrow>>;
const lv = (r: LayVerRow): LayoutVersionView => ({
  id: r.id, version: r.version, status: r.status, headerHtml: r.headerHtml, footerHtml: r.footerHtml, theme: parseTheme(r.theme),
  createdBy: r.createdBy, createdAt: iso(r.createdAt), publishedBy: r.publishedBy, publishedAt: isoN(r.publishedAt),
});
type TplRow = Awaited<ReturnType<typeof prisma.messageTemplate.findFirstOrThrow>>;
const trow = (r: TplRow): TemplateRowView => ({
  id: r.id, key: r.key, channel: r.channel, locale: r.locale, name: r.name, description: r.description, layoutId: r.layoutId, enabled: r.enabled,
  publishedVersionId: r.publishedVersionId, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
});

export const templateDraftToken = (v: Pick<TemplateVersionView, "id" | "subject" | "preheader" | "body" | "changeNote">) =>
  createHash("sha256").update(JSON.stringify([v.id, v.subject, v.preheader, v.body, v.changeNote])).digest("hex").slice(0, 24);
export const layoutDraftToken = (v: Pick<LayoutVersionView, "id" | "headerHtml" | "footerHtml" | "theme">) =>
  createHash("sha256").update(JSON.stringify([v.id, v.headerHtml, v.footerHtml, v.theme])).digest("hex").slice(0, 24);

// ---------------------------------------------------------------------------------------------
// Templates: read
// ---------------------------------------------------------------------------------------------
export async function listTemplates(): Promise<TemplateListGroup[]> {
  const rows = await prisma.messageTemplate.findMany({
    orderBy: [{ key: "asc" }, { channel: "asc" }, { locale: "asc" }],
    include: { published: { select: { version: true } }, versions: { where: { status: "draft" }, select: { id: true }, take: 1 } },
  });
  const defs = new Map(listTemplateDefinitions().map((d) => [d.key, d]));
  const byKey = new Map<string, TemplateListRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.key) ?? [];
    list.push({ ...trow(r), publishedVersion: r.published?.version ?? null, hasDraft: r.versions.length > 0, lastEditedAt: iso(r.updatedAt) });
    byKey.set(r.key, list);
  }
  const keys = [...new Set([...defs.keys(), ...byKey.keys()])].sort();
  return keys.map((key) => {
    const def = defs.get(key) ?? null;
    const list = byKey.get(key) ?? [];
    const have = new Set(list.map((r) => r.channel));
    return {
      key,
      name: def?.name ?? list[0]?.name ?? key,
      description: def?.description ?? list[0]?.description ?? null,
      category: def?.category ?? null,
      definition: def,
      rows: list,
      missingChannels: def ? def.channels.filter((c) => !have.has(c) && def.defaults[c]) : [],
    };
  });
}

export async function getTemplate(id: string): Promise<TemplateDetail | null> {
  const t = await prisma.messageTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!t) return null;
  const versions = t.versions.map(tv);
  const draft = versions.find((v) => v.status === "draft") ?? null;
  return {
    template: trow(t),
    definition: getTemplateDefinition(t.key) ?? null,
    versions,
    published: versions.find((v) => v.id === t.publishedVersionId) ?? null,
    draft,
    draftToken: draft ? templateDraftToken(draft) : null,
  };
}

export async function getTemplateVersion(versionId: string): Promise<(TemplateVersionView & { templateId: string }) | null> {
  const r = await prisma.messageTemplateVersion.findUnique({ where: { id: versionId } });
  return r ? { ...tv(r), templateId: r.templateId } : null;
}

// ---------------------------------------------------------------------------------------------
// Templates: write
// ---------------------------------------------------------------------------------------------
export interface DraftInput {
  subject?: string | null;
  preheader?: string | null;
  body: string;
  changeNote?: string | null;
}

function cleanDraft(channel: TemplateChannel, input: DraftInput) {
  const subject = input.subject == null || input.subject === "" ? null : cleanPlainText(input.subject, "Subject", { multiline: false });
  if (subject && subject.length > 300) throw new DomainError("validation", "Subject is too long (300 characters max).");
  const preheader = input.preheader == null || input.preheader === "" ? null : cleanPlainText(input.preheader, "Preheader", { multiline: false });
  if (preheader && preheader.length > 300) throw new DomainError("validation", "Preheader is too long (300 characters max).");
  if (channel === "email" && !subject) throw new DomainError("validation", "An email needs a subject.");
  if (input.body.length > 200_000) throw new DomainError("validation", "Content is too large.");
  const body = channel === "email" ? cleanEmailHtml(input.body, "Body") : cleanPlainText(input.body, "Body");
  if (!body.trim()) throw new DomainError("validation", "The body can't be empty.");
  const changeNote = input.changeNote?.trim().slice(0, 300) || null;
  return { subject, preheader: channel === "email" ? preheader : null, body, changeNote };
}

/** Unknown variables referenced by the content (warning only: they render empty). */
export function unknownVariables(def: TemplateDefinition | null | undefined, ...texts: (string | null | undefined)[]): string[] {
  if (!def) return [];
  const known = new Set([...def.variables.map((v) => v.name), "brand", "whyReceiving", "unsubscribeUrl", "year"]);
  return [...new Set(texts.flatMap((t) => (t ? referencedVariables(t) : [])))].filter((n) => !known.has(n));
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
/** Serialise writers per template/layout (drafts, version numbers and the published pointer are all derived from the row's state). */
const lockTemplate = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM message_templates WHERE id = ${id}::uuid FOR UPDATE`;
const lockLayout = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM message_layouts WHERE id = ${id}::uuid FOR UPDATE`;

async function nextVersion(tx: Pick<typeof prisma, "messageTemplateVersion">, templateId: string) {
  const max = await tx.messageTemplateVersion.aggregate({ where: { templateId }, _max: { version: true } });
  return (max._max.version ?? 0) + 1;
}

/** Returns the open draft, creating one from `fromVersionId` (default: the published version) when none exists. */
export async function startDraft(templateId: string, actor: string | null, fromVersionId?: string): Promise<TemplateVersionView> {
  return prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const t = await tx.messageTemplate.findUnique({ where: { id: templateId } });
    if (!t) throw new DomainError("not_found", "Template not found.");
    const existing = await tx.messageTemplateVersion.findFirst({ where: { templateId, status: "draft" } });
    if (existing) return tv(existing);
    const srcId = fromVersionId ?? t.publishedVersionId;
    const src = srcId ? await tx.messageTemplateVersion.findFirst({ where: { id: srcId, templateId } }) : null;
    if (srcId && !src) throw new DomainError("not_found", "Source version not found.");
    const created = await tx.messageTemplateVersion.create({
      data: {
        templateId,
        version: await nextVersion(tx, templateId),
        subject: src?.subject ?? null,
        preheader: src?.preheader ?? null,
        body: src?.body ?? "",
        status: "draft",
        changeNote: src ? `Based on v${src.version}` : null,
        createdBy: actor,
      },
    });
    return tv(created);
  });
}

/** Edit the open draft. Rejects with `conflict` when the draft changed since the caller loaded it (token mismatch). */
export async function saveDraft(templateId: string, input: DraftInput & { token?: string | null }): Promise<{ draft: TemplateVersionView; token: string; warnings: string[] }> {
  return prisma.$transaction(async (tx) => {
    const t = await tx.messageTemplate.findUnique({ where: { id: templateId } });
    if (!t) throw new DomainError("not_found", "Template not found.");
    const draftRow = await tx.messageTemplateVersion.findFirst({ where: { templateId, status: "draft" } });
    if (!draftRow) throw new DomainError("conflict", "There is no open draft (it may have been published or discarded). Reload the page.");
    await tx.$queryRaw`SELECT id FROM message_template_versions WHERE id = ${draftRow.id}::uuid FOR UPDATE`;
    const current = tv((await tx.messageTemplateVersion.findUniqueOrThrow({ where: { id: draftRow.id } })));
    if (input.token && input.token !== templateDraftToken(current)) {
      throw new DomainError("conflict", "This draft was changed by someone else since you opened it. Reload to see their changes.");
    }
    const clean = cleanDraft(t.channel, input);
    const updated = await tx.messageTemplateVersion.update({ where: { id: draftRow.id }, data: clean });
    const draft = tv(updated);
    return { draft, token: templateDraftToken(draft), warnings: unknownVariables(getTemplateDefinition(t.key), clean.subject, clean.preheader, clean.body) };
  });
}

/** Abandon the open draft (kept for history as "archived"). */
export async function discardDraft(templateId: string): Promise<void> {
  await prisma.messageTemplateVersion.updateMany({ where: { templateId, status: "draft" }, data: { status: "archived", changeNote: "Discarded draft" } });
}

async function publishIn(tx: Tx, templateId: string, versionId: string, actor: string | null) {
  await lockTemplate(tx, templateId);
  const t = await tx.messageTemplate.findUniqueOrThrow({ where: { id: templateId } });
  if (t.publishedVersionId && t.publishedVersionId !== versionId) {
    await tx.messageTemplateVersion.update({ where: { id: t.publishedVersionId }, data: { status: "archived" } });
  }
  await tx.messageTemplate.update({ where: { id: templateId }, data: { publishedVersionId: null } });
  await tx.messageTemplateVersion.update({ where: { id: versionId }, data: { status: "published", publishedBy: actor, publishedAt: new Date() } });
  await tx.messageTemplate.update({ where: { id: templateId }, data: { publishedVersionId: versionId } });
  return t;
}

/** Publish the open draft: mark published, repoint the template, archive the previous published version, bust caches. */
export async function publishDraft(versionId: string, actor: string | null): Promise<TemplateVersionView> {
  const t = await prisma.$transaction(async (tx) => {
    const v = await tx.messageTemplateVersion.findUnique({ where: { id: versionId }, include: { template: true } });
    if (!v) throw new DomainError("not_found", "Version not found.");
    if (v.status !== "draft") throw new DomainError("conflict", "Only a draft can be published. Use rollback to re-publish an older version.");
    // re-validate: content must still satisfy the current sanitiser/syntax rules
    cleanDraft(v.template.channel, v);
    await publishIn(tx, v.templateId, versionId, actor);
    return v.template;
  });
  await bust(tplPtrKey(t.key, t.channel, t.locale));
  return tv(await prisma.messageTemplateVersion.findUniqueOrThrow({ where: { id: versionId } }));
}

/** Rollback = publish an older version's content as a NEW version (history stays append-only). */
export async function rollbackTemplate(templateId: string, toVersionId: string, actor: string | null): Promise<TemplateVersionView> {
  const { created, t } = await prisma.$transaction(async (tx) => {
    await lockTemplate(tx, templateId);
    const t = await tx.messageTemplate.findUnique({ where: { id: templateId } });
    if (!t) throw new DomainError("not_found", "Template not found.");
    const old = await tx.messageTemplateVersion.findFirst({ where: { id: toVersionId, templateId } });
    if (!old) throw new DomainError("not_found", "Version not found.");
    if (old.status === "draft") throw new DomainError("validation", "Can't roll back to an unpublished draft.");
    const created = await tx.messageTemplateVersion.create({
      data: {
        templateId, version: await nextVersion(tx, templateId), subject: old.subject, preheader: old.preheader, body: old.body,
        status: "draft", changeNote: `Rollback to v${old.version}`, createdBy: actor,
      },
    });
    await publishIn(tx, templateId, created.id, actor);
    return { created, t };
  });
  await bust(tplPtrKey(t.key, t.channel, t.locale));
  return tv(await prisma.messageTemplateVersion.findUniqueOrThrow({ where: { id: created.id } }));
}

export async function setTemplateEnabled(templateId: string, enabled: boolean): Promise<void> {
  const t = await prisma.messageTemplate.update({ where: { id: templateId }, data: { enabled } }).catch(() => null);
  if (!t) throw new DomainError("not_found", "Template not found.");
  await bust(tplPtrKey(t.key, t.channel, t.locale));
}

export async function setTemplateLayout(templateId: string, layoutId: string | null): Promise<void> {
  if (layoutId && !(await prisma.messageLayout.findUnique({ where: { id: layoutId }, select: { id: true } }))) throw new DomainError("not_found", "Layout not found.");
  const t = await prisma.messageTemplate.update({ where: { id: templateId }, data: { layoutId } }).catch(() => null);
  if (!t) throw new DomainError("not_found", "Template not found.");
  await bust(tplPtrKey(t.key, t.channel, t.locale));
}

/** Add a locale for a key/channel, starting from the published English content (or the code default). */
export async function createTemplateLocale(key: string, channel: TemplateChannel, locale: string, actor: string | null): Promise<TemplateRowView> {
  const loc = locale.trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(loc)) throw new DomainError("validation", 'Locale must look like "hi" or "en-IN".');
  const def = getTemplateDefinition(key);
  if (!def) throw new DomainError("not_found", "Unknown template key.");
  if (!def.channels.includes(channel)) throw new DomainError("validation", "This template doesn't support that channel.");
  const en = await prisma.messageTemplate.findUnique({ where: { key_channel_locale: { key, channel, locale: "en" } }, include: { published: true } });
  const seed = en?.published ?? null;
  const dflt = def.defaults[channel];
  if (!seed && !dflt) throw new DomainError("validation", "No content to start from.");
  try {
    const row = await prisma.$transaction(async (tx) => {
      const t = await tx.messageTemplate.create({ data: { key, channel, locale: loc, name: def.name, description: def.description, layoutId: en?.layoutId ?? null } });
      const v = await tx.messageTemplateVersion.create({
        data: {
          templateId: t.id, version: 1, status: "draft", createdBy: actor, changeNote: `Created from ${seed ? "English" : "defaults"}`,
          subject: seed?.subject ?? dflt?.subject ?? null, preheader: seed?.preheader ?? dflt?.preheader ?? null, body: seed?.body ?? dflt!.body,
        },
      });
      return { t, v };
    });
    return trow(row.t);
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new DomainError("conflict", "That locale already exists.");
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------------------------
export async function listLayouts() {
  const rows = await prisma.messageLayout.findMany({
    orderBy: { key: "asc" },
    include: { published: { select: { version: true } }, versions: { where: { status: "draft" }, select: { id: true }, take: 1 }, _count: { select: { templates: true } } },
  });
  return rows.map((l) => ({ id: l.id, key: l.key, name: l.name, publishedVersion: l.published?.version ?? null, hasDraft: l.versions.length > 0, templateCount: l._count.templates, updatedAt: iso(l.updatedAt) }));
}

export async function getLayout(id: string): Promise<LayoutDetail | null> {
  const l = await prisma.messageLayout.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" } } } });
  if (!l) return null;
  const versions = l.versions.map(lv);
  const draft = versions.find((v) => v.status === "draft") ?? null;
  return {
    layout: { id: l.id, key: l.key, name: l.name, publishedVersionId: l.publishedVersionId, updatedAt: iso(l.updatedAt) },
    versions,
    published: versions.find((v) => v.id === l.publishedVersionId) ?? null,
    draft,
    draftToken: draft ? layoutDraftToken(draft) : null,
  };
}

export async function startLayoutDraft(layoutId: string, actor: string | null, fromVersionId?: string): Promise<LayoutVersionView> {
  return prisma.$transaction(async (tx) => {
    await lockLayout(tx, layoutId);
    const l = await tx.messageLayout.findUnique({ where: { id: layoutId } });
    if (!l) throw new DomainError("not_found", "Layout not found.");
    const existing = await tx.messageLayoutVersion.findFirst({ where: { layoutId, status: "draft" } });
    if (existing) return lv(existing);
    const srcId = fromVersionId ?? l.publishedVersionId;
    const src = srcId ? await tx.messageLayoutVersion.findFirst({ where: { id: srcId, layoutId } }) : null;
    const max = await tx.messageLayoutVersion.aggregate({ where: { layoutId }, _max: { version: true } });
    const created = await tx.messageLayoutVersion.create({
      data: {
        layoutId, version: (max._max.version ?? 0) + 1, status: "draft", createdBy: actor,
        headerHtml: src?.headerHtml ?? DEFAULT_LAYOUT.headerHtml, footerHtml: src?.footerHtml ?? DEFAULT_LAYOUT.footerHtml,
        theme: (src?.theme ?? JSON.parse(JSON.stringify(DEFAULT_LAYOUT.theme))) as object,
      },
    });
    return lv(created);
  });
}

export interface LayoutDraftInput {
  headerHtml: string;
  footerHtml: string;
  theme: unknown;
  token?: string | null;
}

export async function saveLayoutDraft(layoutId: string, input: LayoutDraftInput): Promise<{ draft: LayoutVersionView; token: string }> {
  return prisma.$transaction(async (tx) => {
    const d = await tx.messageLayoutVersion.findFirst({ where: { layoutId, status: "draft" } });
    if (!d) throw new DomainError("conflict", "There is no open draft (it may have been published or discarded). Reload the page.");
    await tx.$queryRaw`SELECT id FROM message_layout_versions WHERE id = ${d.id}::uuid FOR UPDATE`;
    const current = lv(await tx.messageLayoutVersion.findUniqueOrThrow({ where: { id: d.id } }));
    if (input.token && input.token !== layoutDraftToken(current)) throw new DomainError("conflict", "This draft was changed by someone else since you opened it. Reload to see their changes.");
    const theme = parseTheme(input.theme);
    const updated = await tx.messageLayoutVersion.update({
      where: { id: d.id },
      data: { headerHtml: cleanEmailHtml(input.headerHtml, "Header"), footerHtml: cleanEmailHtml(input.footerHtml, "Footer"), theme: JSON.parse(JSON.stringify(theme)) },
    });
    const draft = lv(updated);
    return { draft, token: layoutDraftToken(draft) };
  });
}

export async function discardLayoutDraft(layoutId: string): Promise<void> {
  await prisma.messageLayoutVersion.updateMany({ where: { layoutId, status: "draft" }, data: { status: "archived" } });
}

async function publishLayoutIn(tx: Tx, layoutId: string, versionId: string, actor: string | null) {
  await lockLayout(tx, layoutId);
  const l = await tx.messageLayout.findUniqueOrThrow({ where: { id: layoutId } });
  if (l.publishedVersionId && l.publishedVersionId !== versionId) await tx.messageLayoutVersion.update({ where: { id: l.publishedVersionId }, data: { status: "archived" } });
  await tx.messageLayout.update({ where: { id: layoutId }, data: { publishedVersionId: null } });
  await tx.messageLayoutVersion.update({ where: { id: versionId }, data: { status: "published", publishedBy: actor, publishedAt: new Date() } });
  await tx.messageLayout.update({ where: { id: layoutId }, data: { publishedVersionId: versionId } });
  return l;
}

export async function publishLayoutDraft(versionId: string, actor: string | null): Promise<LayoutVersionView> {
  const layoutKey = await prisma.$transaction(async (tx) => {
    const v = await tx.messageLayoutVersion.findUnique({ where: { id: versionId }, include: { layout: true } });
    if (!v) throw new DomainError("not_found", "Version not found.");
    if (v.status !== "draft") throw new DomainError("conflict", "Only a draft can be published. Use rollback to re-publish an older version.");
    cleanEmailHtml(v.headerHtml, "Header");
    cleanEmailHtml(v.footerHtml, "Footer");
    await publishLayoutIn(tx, v.layoutId, versionId, actor);
    return v.layout.key;
  });
  await bust(layoutPtrKey(layoutKey));
  return lv(await prisma.messageLayoutVersion.findUniqueOrThrow({ where: { id: versionId } }));
}

export async function rollbackLayout(layoutId: string, toVersionId: string, actor: string | null): Promise<LayoutVersionView> {
  const { created, key } = await prisma.$transaction(async (tx) => {
    await lockLayout(tx, layoutId);
    const l = await tx.messageLayout.findUnique({ where: { id: layoutId } });
    if (!l) throw new DomainError("not_found", "Layout not found.");
    const old = await tx.messageLayoutVersion.findFirst({ where: { id: toVersionId, layoutId } });
    if (!old) throw new DomainError("not_found", "Version not found.");
    if (old.status === "draft") throw new DomainError("validation", "Can't roll back to an unpublished draft.");
    const max = await tx.messageLayoutVersion.aggregate({ where: { layoutId }, _max: { version: true } });
    const created = await tx.messageLayoutVersion.create({
      data: { layoutId, version: (max._max.version ?? 0) + 1, status: "draft", createdBy: actor, headerHtml: old.headerHtml, footerHtml: old.footerHtml, theme: old.theme as object },
    });
    await publishLayoutIn(tx, layoutId, created.id, actor);
    return { created, key: l.key };
  });
  await bust(layoutPtrKey(key));
  return lv(await prisma.messageLayoutVersion.findUniqueOrThrow({ where: { id: created.id } }));
}
