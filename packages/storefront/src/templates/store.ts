// Template gallery: read for sellers (Studio), CRUD for staff (admin), apply into a seller's draft.
import { DomainError } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { getTrustProfiles } from "@cnote/identity";
import { LIMITS, mapStrings, validateDocument, validateDocumentClamped, type DocumentIssue, type StorefrontDocument } from "../document";
import { replaceDraft, type DraftState } from "../service";
import { TEMPLATE_SEEDS } from "./seeds";

export interface TemplateView {
  id: string;
  key: string;
  name: string;
  description: string;
  verticals: string[];
  tags: string[];
  document: StorefrontDocument;
  previewUrl: string | null;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

function toView(r: Prisma.StorefrontTemplateGetPayload<object>): TemplateView | null {
  const v = validateDocument(r.document);
  if (!v.ok) {
    console.error(`[storefront] template ${r.key} is invalid:`, v.issues.slice(0, 2));
    return null;
  }
  return {
    id: r.id, key: r.key, name: r.name, description: r.description, verticals: r.verticals, tags: r.tags, document: v.document,
    previewUrl: r.previewUrl, active: r.active, sortOrder: r.sortOrder, updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listTemplates(opts: { vertical?: string; tag?: string; includeInactive?: boolean } = {}): Promise<TemplateView[]> {
  const rows = await prisma.storefrontTemplate.findMany({
    where: {
      ...(opts.includeInactive ? {} : { active: true }),
      ...(opts.vertical ? { OR: [{ verticals: { has: opts.vertical } }, { verticals: { isEmpty: true } }] } : {}),
      ...(opts.tag ? { tags: { has: opts.tag } } : {}),
    },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.flatMap((r) => toView(r) ?? []);
}

export async function getTemplate(key: string): Promise<TemplateView | null> {
  const r = await prisma.storefrontTemplate.findUnique({ where: { key } });
  return r ? toView(r) : null;
}

/** Replaces {{name}} / {{city}} with the seller's real details. Missing city falls back to "India". */
export function mergeSellerData(doc: StorefrontDocument, seller: { name: string; city: string | null }): StorefrontDocument {
  const name = seller.name.trim().slice(0, 60);
  const city = (seller.city ?? "").trim().slice(0, 40) || "India";
  return mapStrings(doc, (s) => s.replace(/\{\{\s*name\s*\}\}/gi, name).replace(/\{\{\s*city\s*\}\}/gi, city));
}

/**
 * Applies a template to the seller's storefront: merges real business data, validates, and starts a fresh draft
 * (the previous draft stays in version history). Product grids use source "all", so they show the seller's real listings.
 */
export async function applyTemplate(sellerBusinessId: string, personId: string, key: string): Promise<DraftState> {
  const tpl = await getTemplate(key);
  if (!tpl || !tpl.active) throw new DomainError("not_found", "That template is not available.", undefined, "storefront.templateNotAvailable");
  const p = (await getTrustProfiles([sellerBusinessId])).get(sellerBusinessId);
  if (!p) throw new DomainError("not_found", "Business not found.", undefined, "account.businessNotFound");
  const merged = mergeSellerData(tpl.document, { name: p.name, city: p.city });
  const v = validateDocumentClamped(merged);
  if (!v.ok) throw new DomainError("validation", "This template could not be applied to your details. Please contact support.", { issues: v.issues }, "storefront.templateCouldNotAppliedDetails");
  return replaceDraft(sellerBusinessId, personId, v.document, { templateKey: tpl.key });
}

// ---- staff (call inside admin.audited(ctx, "storefronts.templates", …)) -------------------------

export interface TemplateInput {
  key: string;
  name: string;
  description: string;
  verticals?: string[];
  tags?: string[];
  document: unknown;
  previewUrl?: string | null;
  active?: boolean;
  sortOrder?: number;
}

export function validateTemplateInput(input: TemplateInput): { ok: true; document: StorefrontDocument } | { ok: false; issues: DocumentIssue[] } {
  const issues: DocumentIssue[] = [];
  if (!KEY_RE.test(input.key)) issues.push({ path: "key", message: "Key: 2-40 lowercase letters, digits or hyphens." });
  if (!input.name.trim() || input.name.length > 60) issues.push({ path: "name", message: "Name is required (max 60 characters)." });
  if (!input.description.trim() || input.description.length > 300) issues.push({ path: "description", message: "Description is required (max 300 characters)." });
  const v = validateDocument(input.document);
  if (!v.ok) issues.push(...v.issues);
  if (issues.length || !v.ok) return { ok: false, issues };
  if (JSON.stringify(v.document).length > LIMITS.documentBytes) return { ok: false, issues: [{ path: "document", message: "Template is too large." }] };
  return { ok: true, document: v.document };
}

const list = (xs?: string[]) => [...new Set((xs ?? []).map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 12);

export async function upsertTemplate(input: TemplateInput, staffId: string): Promise<TemplateView> {
  const v = validateTemplateInput(input);
  if (!v.ok) throw new DomainError("validation", "The template is not valid.", { issues: v.issues }, "storefront.templateNotValid");
  const data = {
    name: input.name.trim(), description: input.description.trim(), verticals: list(input.verticals), tags: list(input.tags),
    document: v.document as unknown as Prisma.InputJsonValue, previewUrl: input.previewUrl ?? null,
    ...(input.active !== undefined ? { active: input.active } : {}), ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  };
  const row = await prisma.storefrontTemplate.upsert({ where: { key: input.key }, create: { key: input.key, createdBy: staffId, ...data }, update: data });
  const view = toView(row);
  if (!view) throw new DomainError("validation", "The template is not valid.", undefined, "storefront.templateNotValid");
  return view;
}

export async function setTemplateActive(key: string, active: boolean): Promise<void> {
  const r = await prisma.storefrontTemplate.updateMany({ where: { key }, data: { active } });
  if (!r.count) throw new DomainError("not_found", "Template not found.", undefined, "storefront.templateNotFound");
}

/** Persist a new gallery order: `keys` first (in order), everything else after. */
export async function reorderTemplates(keys: string[]): Promise<void> {
  await prisma.$transaction(keys.map((key, i) => prisma.storefrontTemplate.updateMany({ where: { key }, data: { sortOrder: (i + 1) * 10 } })));
}

/** Idempotent: creates the six built-in templates that do not exist yet (staff edits are never overwritten unless `overwrite`). */
export async function seedStorefrontTemplates(opts: { overwrite?: boolean } = {}): Promise<{ created: string[]; updated: string[] }> {
  const created: string[] = [];
  const updated: string[] = [];
  for (const t of TEMPLATE_SEEDS) {
    const data = {
      name: t.name, description: t.description, verticals: t.verticals, tags: t.tags, sortOrder: t.sortOrder,
      document: t.document as unknown as Prisma.InputJsonValue,
    };
    const exists = await prisma.storefrontTemplate.findUnique({ where: { key: t.key }, select: { id: true } });
    if (!exists) {
      await prisma.storefrontTemplate.create({ data: { key: t.key, active: true, ...data } });
      created.push(t.key);
    } else if (opts.overwrite) {
      await prisma.storefrontTemplate.update({ where: { key: t.key }, data });
      updated.push(t.key);
    }
  }
  return { created, updated };
}
