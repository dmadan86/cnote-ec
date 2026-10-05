import { upsertCategories, type CategoryDef } from "@cnote/catalogue";
import { DomainError } from "@cnote/core";
import { createVerticalFromTemplate } from "../template";
import { getVerticalBySlug } from "../verticals";
import type { VerticalView } from "../types";
import { PACKAGING_BENGALURU } from "./packaging-bengaluru";
import type { Playbook, PlaybookCategory, Regulation } from "./schema";

export * from "./schema";
export { PACKAGING_BENGALURU } from "./packaging-bengaluru";

/**
 * Registry of available playbooks. Having an entry here does NOT activate anything: playbooks are inert data until
 * `loadPlaybook` is called by a deliberate admin/seed action. To add a vertical, add a file and register it here.
 */
export const PLAYBOOKS: Readonly<Record<string, Playbook>> = Object.freeze({
  [PACKAGING_BENGALURU.key]: PACKAGING_BENGALURU,
});

export function listPlaybooks(): { key: string; name: string; version: number; decisionStatus: string; categories: number }[] {
  return Object.values(PLAYBOOKS).map((p) => ({ key: p.key, name: p.name, version: p.version, decisionStatus: p.decisionStatus, categories: p.categories.length }));
}

export function getPlaybook(key: string): Playbook | null {
  return Object.hasOwn(PLAYBOOKS, key) ? PLAYBOOKS[key]! : null;
}

/** Attribute that regulated subcategories (certificate required) gain; the certificate itself is referenced, not stored in the category. */
export const CERTIFICATE_FIELD = { key: "certificate_ref", label: "Certificate / test report reference", type: "text" as const, required: true };

export const playbookRequiresCertificate = (c: PlaybookCategory): boolean => c.regulations.some((r) => r.requiresCertificate);

/** Maps a playbook to catalogue `CategoryDef`s (same shape the seed and admin tools upsert). Pure. */
export function playbookToCategoryDefs(pb: Playbook): CategoryDef[] {
  return pb.categories.map((c, i) => {
    const fields = c.attributes.map((a) => ({ key: a.key, label: a.label, type: a.type, ...(a.required ? { required: true } : {}), ...(a.unit ? { unit: a.unit } : {}), ...(a.options ? { options: [...a.options] } : {}) }));
    if (playbookRequiresCertificate(c) && !fields.some((f) => f.key === CERTIFICATE_FIELD.key)) fields.push({ ...CERTIFICATE_FIELD });
    return {
      slug: c.slug,
      name: c.name,
      icon: c.icon ?? null,
      leadCap: c.leadCap ?? 3,
      prohibited: c.prohibited ?? false,
      attributeSchema: { fields },
      sortOrder: c.sortOrder ?? i,
      parentSlug: c.parentSlug ?? null,
    };
  });
}

/** Regulations that apply to a category: its own plus those of its ancestors. */
export function regulationsFor(pb: Playbook, categorySlug: string): Regulation[] {
  const bySlug = new Map(pb.categories.map((c) => [c.slug, c]));
  const out: Regulation[] = [];
  const seen = new Set<string>();
  for (let cur = bySlug.get(categorySlug); cur && !seen.has(cur.slug); cur = cur.parentSlug ? bySlug.get(cur.parentSlug) : undefined) {
    seen.add(cur.slug);
    out.push(...cur.regulations);
  }
  return out;
}

/** True when listings in this category (or an ancestor) must carry a certificate / test-report reference. */
export function categoryNeedsCertificate(pb: Playbook, categorySlug: string): boolean {
  return regulationsFor(pb, categorySlug).some((r) => r.requiresCertificate);
}

/** Checks a listing's numeric attributes against the playbook's hard constraints. Returns human-readable problems. */
export function checkPlaybookConstraints(pb: Playbook, categorySlug: string, attrs: Record<string, string | number>): string[] {
  const cat = pb.categories.find((c) => c.slug === categorySlug);
  if (!cat) return [];
  const problems: string[] = [];
  if (cat.prohibited) problems.push(`${cat.name}: category is prohibited`);
  for (const k of cat.constraints) {
    const raw = attrs[k.field];
    if (raw === undefined || raw === "") continue;
    const v = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(v)) { problems.push(`${k.field}: must be a number`); continue; }
    if ((k.min !== undefined && v < k.min) || (k.max !== undefined && v > k.max)) problems.push(k.message);
  }
  return problems;
}

/** The category list in the format of `packages/ai/evals/data/categories.json`, so proposed golden sets can be promoted. */
export function playbookToEvalCategories(pb: Playbook): { slug: string; name: string; attributeSchema: { fields: unknown[] } }[] {
  return playbookToCategoryDefs(pb).filter((c) => !c.prohibited).map((c) => ({ slug: c.slug, name: c.name, attributeSchema: { fields: c.attributeSchema?.fields ?? [] } }));
}

export interface LoadPlaybookResult {
  playbook: string;
  categories: number;
  vertical: VerticalView | null;
  verticalCreated: boolean;
}

/**
 * EXPLICIT activation of a playbook: upserts its category tree (idempotent by slug) and, unless
 * `createVertical: false`, creates the vertical as a `candidate` with the ADR-016 checklist when it does not exist.
 * It never changes a stage, so loading cannot open a vertical; ADR-016 gates still apply.
 * Callers: `pnpm db:seed -- --vertical=<key> [--only]`, or an audited admin action.
 */
export async function loadPlaybook(key: string, opts: { createVertical?: boolean } = {}): Promise<LoadPlaybookResult> {
  const pb = getPlaybook(key);
  if (!pb) throw new DomainError("not_found", `Unknown vertical playbook "${key}". Available: ${Object.keys(PLAYBOOKS).join(", ") || "none"}.`);
  const defs = playbookToCategoryDefs(pb);
  await upsertCategories(defs);
  if (opts.createVertical === false) return { playbook: pb.key, categories: defs.length, vertical: null, verticalCreated: false };

  const existing = await getVerticalBySlug(pb.key);
  if (existing) return { playbook: pb.key, categories: defs.length, vertical: existing, verticalCreated: false };
  const root = pb.categories.find((c) => !c.parentSlug)!;
  const vertical = await createVerticalFromTemplate({
    slug: pb.key,
    name: pb.name,
    categorySlugs: [root.slug],
    languages: pb.languages,
    clusters: pb.clusters,
    gates: pb.gates,
    attributeSchemaSlug: root.slug,
    notes: `Loaded from playbook v${pb.version}. ${pb.decisionStatus}`,
  });
  return { playbook: pb.key, categories: defs.length, vertical, verticalCreated: true };
}
