import { cachedTagged, DomainError, emit, invalidateTags } from "@cnote/core";
import { getCategoryBySlug, listCategories } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { blockingVerticals } from "./gates";
import { toChangeView, toItemView, toVerticalView } from "./mappers";
import {
  CHECKLIST_SECTIONS, DEFAULT_GATES, LAUNCHED_STAGES, STAGE_TRANSITIONS, VerticalInputSchema, VerticalPatchSchema,
  type ChecklistItemView, type ChecklistSection, type GateResult, type StageChangeView, type VerticalInput, type VerticalPatch, type VerticalStageName, type VerticalView,
} from "./types";

export const VERTICALS_TAG = "verticals";
const KEY = "verticals:all:v1";
const parse = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") throw new DomainError("validation", (err as unknown as { issues: { message: string }[] }).issues.map((i) => i.message).join("; "));
    throw err;
  }
};
const bust = () => invalidateTags([VERTICALS_TAG]);

// ---------- public config reads (cached) ----------

async function allVerticals(): Promise<VerticalView[]> {
  return cachedTagged(KEY, [VERTICALS_TAG], 300, async () => (await prisma.vertical.findMany({ orderBy: { slug: "asc" } })).map(toVerticalView), { staleSeconds: 900 });
}

/** Open verticals only (config; e.g. for language ordering and onboarding copy). */
export async function listOpenVerticals(): Promise<VerticalView[]> {
  return (await allVerticals()).filter((v) => v.stage === "open");
}

const RANK: Record<VerticalStageName, number> = { open: 3, pilot: 2, paused: 1, candidate: 0 };

/**
 * The vertical covering a category (directly, or via an ancestor category). When several match, the most advanced
 * stage wins. Null when the category is unknown or uncovered.
 */
export async function getVerticalForCategory(categorySlug: string): Promise<VerticalView | null> {
  const verticals = await allVerticals();
  if (verticals.length === 0) return null;
  const cats = await listCategories();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const chain = new Set<string>([categorySlug]);
  let cur = cats.find((c) => c.slug === categorySlug);
  while (cur?.parentId) {
    cur = byId.get(cur.parentId);
    if (!cur || chain.has(cur.slug)) break;
    chain.add(cur.slug);
  }
  const hits = verticals.filter((v) => v.categorySlugs.some((s) => chain.has(s)));
  return hits.sort((a, b) => RANK[b.stage] - RANK[a.stage] || a.slug.localeCompare(b.slug))[0] ?? null;
}

// ---------- staff CRUD ----------

export async function listVerticals(): Promise<VerticalView[]> {
  return (await prisma.vertical.findMany({ orderBy: { slug: "asc" } })).map(toVerticalView);
}

export async function getVertical(id: string): Promise<VerticalView | null> {
  const r = await prisma.vertical.findUnique({ where: { id } });
  return r ? toVerticalView(r) : null;
}

export async function getVerticalBySlug(slug: string): Promise<VerticalView | null> {
  const r = await prisma.vertical.findUnique({ where: { slug } });
  return r ? toVerticalView(r) : null;
}

async function assertCategories(slugs: string[], attributeSchemaSlug?: string | null): Promise<void> {
  const missing: string[] = [];
  for (const s of [...slugs, ...(attributeSchemaSlug ? [attributeSchemaSlug] : [])]) if (!(await getCategoryBySlug(s))) missing.push(s);
  if (missing.length) throw new DomainError("validation", `Unknown category slug(s): ${[...new Set(missing)].join(", ")}.`);
}

/** Creates a vertical in `candidate` stage. Category slugs must exist in the catalogue. */
export async function createVertical(input: VerticalInput): Promise<VerticalView> {
  const d = parse(() => VerticalInputSchema.parse(input));
  await assertCategories(d.categorySlugs, d.attributeSchemaSlug);
  if (await prisma.vertical.findUnique({ where: { slug: d.slug }, select: { id: true } })) throw new DomainError("conflict", `Vertical "${d.slug}" already exists.`);
  const row = await prisma.vertical.create({
    data: {
      slug: d.slug, name: d.name, categorySlugs: d.categorySlugs, languages: d.languages, clusters: d.clusters,
      gates: { ...DEFAULT_GATES, ...d.gates }, classifierConfig: d.classifierConfig, attributeSchemaSlug: d.attributeSchemaSlug ?? null, notes: d.notes ?? null,
    },
  });
  await bust();
  return toVerticalView(row);
}

export async function updateVertical(id: string, patch: VerticalPatch): Promise<VerticalView> {
  const d = parse(() => VerticalPatchSchema.parse(patch));
  const cur = await prisma.vertical.findUnique({ where: { id } });
  if (!cur) throw new DomainError("not_found", "Vertical not found.");
  if (d.categorySlugs || d.attributeSchemaSlug) await assertCategories(d.categorySlugs ?? [], d.attributeSchemaSlug);
  const row = await prisma.vertical.update({
    where: { id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.categorySlugs ? { categorySlugs: d.categorySlugs } : {}),
      ...(d.languages ? { languages: d.languages } : {}),
      ...(d.clusters ? { clusters: d.clusters } : {}),
      ...(d.gates ? { gates: { ...DEFAULT_GATES, ...(cur.gates as object), ...d.gates } } : {}),
      ...(d.classifierConfig ? { classifierConfig: d.classifierConfig } : {}),
      ...(d.attributeSchemaSlug !== undefined ? { attributeSchemaSlug: d.attributeSchemaSlug } : {}),
      ...(d.notes !== undefined ? { notes: d.notes } : {}),
    },
  });
  await bust();
  return toVerticalView(row);
}

// ---------- checklist ----------

export async function listChecklist(verticalId: string): Promise<ChecklistItemView[]> {
  const rows = await prisma.verticalChecklistItem.findMany({ where: { verticalId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });
  const order = (s: string) => CHECKLIST_SECTIONS.indexOf(s as ChecklistSection);
  return rows.map(toItemView).sort((a, b) => order(a.section) - order(b.section) || a.sortOrder - b.sortOrder);
}

const isHttpUrl = (u: string) => /^https?:\/\/\S+$/i.test(u);

export async function addChecklistItem(verticalId: string, input: { section: ChecklistSection; title: string; owner?: string | null; sortOrder?: number }): Promise<ChecklistItemView> {
  if (!CHECKLIST_SECTIONS.includes(input.section)) throw new DomainError("validation", "Unknown checklist section.");
  const title = input.title.trim();
  if (title.length < 2 || title.length > 200) throw new DomainError("validation", "Title must be 2-200 characters.");
  if (!(await prisma.vertical.findUnique({ where: { id: verticalId }, select: { id: true } }))) throw new DomainError("not_found", "Vertical not found.");
  const last = await prisma.verticalChecklistItem.findFirst({ where: { verticalId, section: input.section }, orderBy: { sortOrder: "desc" } });
  const row = await prisma.verticalChecklistItem.create({
    data: { verticalId, section: input.section, title, owner: input.owner?.trim() || null, sortOrder: input.sortOrder ?? (last ? last.sortOrder + 1 : 0) },
  });
  return toItemView(row);
}

/** Toggle/annotate an item. Marking done requires an owner-agnostic evidence URL only when one is supplied (validated). */
export async function updateChecklistItem(itemId: string, patch: { done?: boolean; owner?: string | null; evidenceUrl?: string | null; title?: string }): Promise<ChecklistItemView> {
  const cur = await prisma.verticalChecklistItem.findUnique({ where: { id: itemId } });
  if (!cur) throw new DomainError("not_found", "Checklist item not found.");
  const evidence = patch.evidenceUrl === undefined ? undefined : patch.evidenceUrl?.trim() || null;
  if (evidence && !isHttpUrl(evidence)) throw new DomainError("validation", "Evidence must be an http(s) URL.");
  if (patch.title !== undefined && (patch.title.trim().length < 2 || patch.title.trim().length > 200)) throw new DomainError("validation", "Title must be 2-200 characters.");
  const row = await prisma.verticalChecklistItem.update({
    where: { id: itemId },
    data: {
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner?.trim() || null } : {}),
      ...(evidence !== undefined ? { evidenceUrl: evidence } : {}),
      ...(patch.done !== undefined ? { done: patch.done, doneAt: patch.done ? (cur.done ? cur.doneAt : new Date()) : null } : {}),
    },
  });
  return toItemView(row);
}

export async function deleteChecklistItem(itemId: string): Promise<void> {
  await prisma.verticalChecklistItem.deleteMany({ where: { id: itemId } });
}

export async function checklistProgress(verticalId: string): Promise<{ done: number; total: number; bySection: Record<ChecklistSection, { done: number; total: number }> }> {
  const items = await listChecklist(verticalId);
  const bySection = Object.fromEntries(CHECKLIST_SECTIONS.map((s) => [s, { done: 0, total: 0 }])) as Record<ChecklistSection, { done: number; total: number }>;
  for (const i of items) {
    bySection[i.section].total++;
    if (i.done) bySection[i.section].done++;
  }
  return { done: items.filter((i) => i.done).length, total: items.length, bySection };
}

// ---------- stage changes (ADR-016 expansion rule) ----------

export interface ChangeStageInput {
  verticalId: string;
  to: VerticalStageName;
  /** StaffMember id (or "system") */
  changedBy: string;
  /** Staff override of the expansion rule. Required (with a reason) when open verticals fail their gates. The caller must audit it. */
  override?: { reason: string };
}

export interface ChangeStageResult {
  vertical: VerticalView;
  overridden: boolean;
  blockedBy: GateResult[];
}

/**
 * Moves a vertical between stages. ADR-016: a vertical may enter `pilot`/`open` only when every OTHER currently-open
 * vertical meets its gates (>= minVerifiedSellers and positive net adds). Enforced here, server-side; a staff override with
 * a reason (>= 10 chars) bypasses it and is recorded on the stage-change row and in the event log. Emits VerticalStageChanged.
 */
export async function changeStage(input: ChangeStageInput): Promise<ChangeStageResult> {
  const cur = await prisma.vertical.findUnique({ where: { id: input.verticalId } });
  if (!cur) throw new DomainError("not_found", "Vertical not found.");
  const from = cur.stage as VerticalStageName;
  const to = input.to;
  if (from === to) throw new DomainError("conflict", `Vertical is already ${to}.`);
  if (!STAGE_TRANSITIONS[from].includes(to)) throw new DomainError("validation", `Cannot move from ${from} to ${to}. Allowed: ${STAGE_TRANSITIONS[from].join(", ")}.`);

  let blockedBy: GateResult[] = [];
  const entersLaunched = LAUNCHED_STAGES.includes(to) && !LAUNCHED_STAGES.includes(from);
  const pilotToOpen = from === "pilot" && to === "open";
  if (entersLaunched || pilotToOpen) blockedBy = await blockingVerticals(cur.id);

  const reason = input.override?.reason?.trim();
  if (blockedBy.length > 0) {
    if (!input.override) {
      throw new DomainError("conflict", `ADR-016: open verticals must meet their gates before another launches. Blocking: ${blockedBy.map((b) => b.slug).join(", ")}.`, { blockedBy });
    }
    if (!reason || reason.length < 10) throw new DomainError("validation", "An override needs a reason of at least 10 characters.");
  }
  const overridden = blockedBy.length > 0;

  const row = await prisma.$transaction(async (tx) => {
    const moved = await tx.vertical.updateMany({ where: { id: cur.id, stage: from }, data: { stage: to, stageChangedAt: new Date() } });
    if (moved.count === 0) throw new DomainError("conflict", "The vertical changed stage concurrently; reload and retry.");
    await tx.verticalStageChange.create({
      data: {
        verticalId: cur.id, fromStage: from, toStage: to, changedBy: input.changedBy, overridden, overrideReason: overridden ? reason : null,
        gateSnapshot: JSON.parse(JSON.stringify({ blockedBy })),
      },
    });
    await emit(tx, "VerticalStageChanged", { type: "vertical", id: cur.id }, { verticalId: cur.id, slug: cur.slug, from, to, changedBy: input.changedBy });
    return tx.vertical.findUniqueOrThrow({ where: { id: cur.id } });
  });
  await bust();
  return { vertical: toVerticalView(row), overridden, blockedBy };
}

export async function listStageChanges(verticalId: string): Promise<StageChangeView[]> {
  return (await prisma.verticalStageChange.findMany({ where: { verticalId }, orderBy: { createdAt: "desc" } })).map(toChangeView);
}
