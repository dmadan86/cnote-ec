// Category gate (ADR-015): the pilot runs in ONE structured category; expansion only when accuracy > 90% on a labelled set.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { envCategories, minAccuracy, minLabels } from "./config";

export interface CategoryAccuracy {
  categorySlug: string;
  labelled: number;
  correct: number;
  /** null until there is at least one label */
  accuracy: number | null;
  /** labelled >= minLabels and accuracy > minAccuracy */
  meetsGate: boolean;
  minLabels: number;
  minAccuracy: number;
}

/** Accuracy of the model's per-check results against staff labels: correct = same outcome; inconclusive vs a definite label is wrong. */
export async function categoryAccuracy(categorySlug: string): Promise<CategoryAccuracy> {
  const rows = await prisma.$queryRaw<{ labelled: bigint; correct: bigint }[]>`
    SELECT count(*)::bigint AS labelled, count(*) FILTER (WHERE r.result = l.label)::bigint AS correct
    FROM quality_labels l JOIN quality_check_results r ON r.id = l.result_id
    WHERE l.category_slug = ${categorySlug}`;
  const labelled = Number(rows[0]?.labelled ?? 0);
  const correct = Number(rows[0]?.correct ?? 0);
  const accuracy = labelled ? correct / labelled : null;
  const gate = { minLabels: minLabels(), minAccuracy: minAccuracy() };
  return { categorySlug, labelled, correct, accuracy, meetsGate: labelled >= gate.minLabels && accuracy !== null && accuracy > gate.minAccuracy, ...gate };
}

export interface CategoryStatus extends CategoryAccuracy {
  enabled: boolean;
  fromEnv: boolean;
  pilot: boolean;
  updatedAt: string | null;
}

export async function enabledCategories(): Promise<string[]> {
  const rows = await prisma.qualityCategory.findMany({ where: { enabled: true }, select: { categorySlug: true } });
  return [...new Set([...envCategories(), ...rows.map((r) => r.categorySlug)])];
}

export async function isCategoryAllowed(categorySlug: string): Promise<boolean> {
  if (envCategories().includes(categorySlug)) return true;
  const row = await prisma.qualityCategory.findUnique({ where: { categorySlug }, select: { enabled: true } });
  return row?.enabled === true;
}

/** Every category that has results, labels, a config row or an env entry, with its accuracy and gate state. */
export async function listCategoryStatuses(): Promise<CategoryStatus[]> {
  const [cfg, checked] = await Promise.all([
    prisma.qualityCategory.findMany(),
    prisma.qualityCheck.findMany({ distinct: ["categorySlug"], select: { categorySlug: true } }),
  ]);
  const env = envCategories();
  const slugs = [...new Set([...cfg.map((c) => c.categorySlug), ...checked.map((c) => c.categorySlug), ...env])].sort();
  return Promise.all(slugs.map(async (slug) => {
    const c = cfg.find((x) => x.categorySlug === slug);
    return { ...(await categoryAccuracy(slug)), enabled: c?.enabled === true || env.includes(slug), fromEnv: env.includes(slug), pilot: c?.pilot === true, updatedAt: c?.updatedAt.toISOString() ?? null };
  }));
}

/**
 * Enable/disable a category. Enabling is GATED (ADR-015): allowed only when accuracy > minAccuracy with >= minLabels
 * staff labels, except the very first category ever enabled (the pilot), which needs no labels because none can exist yet.
 * Callers (the admin action) wrap this in `audited()`; the row also records who and on what evidence.
 */
export async function setCategoryEnabled(categorySlug: string, enabled: boolean, staffId: string): Promise<CategoryStatus> {
  const slug = categorySlug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(slug)) throw new DomainError("validation", "Invalid category");
  const stats = await categoryAccuracy(slug);
  if (enabled) {
    const everEnabled = await prisma.qualityCategory.count({ where: { OR: [{ enabled: true }, { pilot: true }, { accuracyAtEnable: { not: null } }] } });
    const isPilot = everEnabled === 0;
    if (!isPilot && !stats.meetsGate) {
      throw new DomainError("conflict", `Not enough evidence to enable "${slug}": needs at least ${stats.minLabels} labels and accuracy above ${Math.round(stats.minAccuracy * 100)}% (has ${stats.labelled} labels, ${stats.accuracy === null ? "no accuracy yet" : `${(stats.accuracy * 100).toFixed(1)}%`}).`, stats);
    }
    await prisma.qualityCategory.upsert({
      where: { categorySlug: slug },
      create: { categorySlug: slug, enabled: true, pilot: isPilot, accuracyAtEnable: stats.accuracy ?? 0, labelsAtEnable: stats.labelled, updatedBy: staffId },
      update: { enabled: true, accuracyAtEnable: stats.accuracy ?? 0, labelsAtEnable: stats.labelled, updatedBy: staffId },
    });
  } else {
    await prisma.qualityCategory.upsert({ where: { categorySlug: slug }, create: { categorySlug: slug, enabled: false, updatedBy: staffId }, update: { enabled: false, updatedBy: staffId } });
  }
  return (await listCategoryStatuses()).find((c) => c.categorySlug === slug)!;
}
