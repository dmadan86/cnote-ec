import { cached, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { toCategoryView } from "./mappers";
import type { CategoryView } from "./index";

const KEY = "catalogue:categories:v1";
const TTL_S = 60; // short: category edits are rare, but ops should see them within a minute even if invalidation is missed

export async function listCategories(): Promise<CategoryView[]> {
  return cached(KEY, TTL_S, async () => {
    const rows = await prisma.category.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
    return rows.map(toCategoryView);
  });
}

export async function getCategoryBySlug(slug: string): Promise<CategoryView | null> {
  return (await listCategories()).find((c) => c.slug === slug) ?? null;
}

export async function getCategoryById(id: string): Promise<CategoryView | null> {
  const hit = (await listCategories()).find((c) => c.id === id);
  if (hit) return hit;
  // cache may predate a just-created category
  const row = await prisma.category.findUnique({ where: { id } });
  return row ? toCategoryView(row) : null;
}

export interface CategoryDef {
  slug: string;
  name: string;
  icon?: string | null;
  leadCap?: number;
  prohibited?: boolean;
  attributeSchema?: CategoryView["attributeSchema"];
  sortOrder?: number;
  parentSlug?: string | null;
}

/** Idempotent seed/upsert by slug. Parents are written before children regardless of input order. */
export async function upsertCategories(defs: CategoryDef[]): Promise<CategoryView[]> {
  const bySlug = new Map(defs.map((d) => [d.slug, d]));
  const ordered: CategoryDef[] = [];
  const seen = new Set<string>();
  const visit = (d: CategoryDef, stack: string[]) => {
    if (seen.has(d.slug)) return;
    if (stack.includes(d.slug)) throw new Error(`category parent cycle: ${[...stack, d.slug].join(" > ")}`);
    const parent = d.parentSlug ? bySlug.get(d.parentSlug) : undefined;
    if (parent) visit(parent, [...stack, d.slug]);
    seen.add(d.slug);
    ordered.push(d);
  };
  defs.forEach((d) => visit(d, []));

  const ids = new Map<string, string>();
  const out: CategoryView[] = [];
  for (const d of ordered) {
    let parentId: string | null = null;
    if (d.parentSlug) {
      parentId = ids.get(d.parentSlug) ?? (await prisma.category.findUnique({ where: { slug: d.parentSlug } }))?.id ?? null;
      if (!parentId) throw new Error(`unknown parentSlug "${d.parentSlug}" for category "${d.slug}"`);
    }
    const data = {
      name: d.name,
      icon: d.icon ?? null,
      leadCap: d.leadCap ?? 3,
      prohibited: d.prohibited ?? false,
      attributeSchema: d.attributeSchema ?? { fields: [] },
      sortOrder: d.sortOrder ?? 0,
      parentId,
    };
    const row = await prisma.category.upsert({ where: { slug: d.slug }, create: { slug: d.slug, ...data }, update: data });
    ids.set(d.slug, row.id);
    out.push(toCategoryView(row));
  }
  await redis.del(KEY);
  return out;
}
