// Admin read/write helpers (ADR-022). The admin app wraps every mutation in `audited()` (privilege prices.manage).
import { DomainError } from "@cnote/core";
import { getCategoryById, listCategories } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { getK, priceIntelEnabled } from "./config";
import { regionLabel } from "./regions";

export interface RunRow {
  id: string; period: string; trigger: string; status: string; k: number; samples: number; categories: number; cells: number; suppressedCells: number;
  suppressedReasons: { sellers: number; buyers: number; dominance: number }; error: string | null; startedAt: string; finishedAt: string | null;
}

export async function listRuns(limit = 30): Promise<RunRow[]> {
  const rows = await prisma.priceBenchmarkRun.findMany({ orderBy: { startedAt: "desc" }, take: Math.max(1, Math.min(200, limit)) });
  return rows.map((r) => {
    const s = (r.suppressedReasons ?? {}) as Partial<Record<"sellers" | "buyers" | "dominance", number>>;
    return {
      id: r.id, period: r.period, trigger: r.trigger, status: r.status, k: r.k, samples: r.samples, categories: r.categories, cells: r.cells, suppressedCells: r.suppressedCells,
      suppressedReasons: { sellers: s.sellers ?? 0, buyers: s.buyers ?? 0, dominance: s.dominance ?? 0 }, error: r.error, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

export interface AdminSummary { enabled: boolean; k: number; latest: RunRow | null; publishedCells: number; unpublishedCells: number; suppressionRate: number | null }

export async function adminSummary(): Promise<AdminSummary> {
  const [k, runs, published, unpublished] = await Promise.all([
    getK(), listRuns(1), prisma.priceBenchmark.count({ where: { status: "published" } }), prisma.priceBenchmark.count({ where: { status: "unpublished" } }),
  ]);
  const latest = runs[0] ?? null;
  const total = latest ? latest.cells + latest.suppressedCells : 0;
  return { enabled: priceIntelEnabled(), k, latest, publishedCells: published, unpublishedCells: unpublished, suppressionRate: latest && total > 0 ? latest.suppressedCells / total : null };
}

export interface CellRow {
  id: string; period: string; categoryId: string; categoryName: string; unit: string; region: string; regionLabel: string; tier: string;
  p25Paise: number; medianPaise: number; p75Paise: number; sampleCount: number; sellerCount: number; buyerCount: number; status: string; unpublishedReason: string | null;
}

export async function listCells(opts: { status?: "published" | "unpublished"; categoryId?: string; limit?: number } = {}): Promise<CellRow[]> {
  const [rows, cats] = await Promise.all([
    prisma.priceBenchmark.findMany({
      where: { ...(opts.status ? { status: opts.status } : {}), ...(opts.categoryId ? { categoryId: opts.categoryId } : {}) },
      orderBy: [{ period: "desc" }, { categoryId: "asc" }, { region: "asc" }, { tier: "asc" }], take: Math.max(1, Math.min(500, opts.limit ?? 100)),
    }),
    listCategories(),
  ]);
  const names = new Map(cats.map((c) => [c.id, c.name]));
  // the cached category list can predate a just-created category
  for (const id of new Set(rows.map((r) => r.categoryId))) if (!names.has(id)) { const c = await getCategoryById(id); if (c) names.set(id, c.name); }
  return rows.map((r) => ({
    id: r.id, period: r.period, categoryId: r.categoryId, categoryName: names.get(r.categoryId) ?? "Unknown category", unit: r.unit, region: r.region, regionLabel: regionLabel(r.region), tier: r.tier,
    p25Paise: Number(r.p25Paise), medianPaise: Number(r.p50Paise), p75Paise: Number(r.p75Paise), sampleCount: r.sampleCount, sellerCount: r.sellerCount, buyerCount: r.buyerCount,
    status: r.status, unpublishedReason: r.unpublishedReason,
  }));
}

/** Takes a cell down immediately. Runs keep refreshing its numbers but never re-publish it. Wrap in audited(). */
export async function unpublishCell(id: string, staffId: string | null, reason: string): Promise<void> {
  const r = reason.trim();
  if (r.length < 3) throw new DomainError("validation", "Give a reason (min 3 characters).");
  const res = await prisma.priceBenchmark.updateMany({ where: { id }, data: { status: "unpublished", unpublishedReason: r.slice(0, 300), unpublishedBy: staffId, unpublishedAt: new Date() } });
  if (res.count === 0) throw new DomainError("not_found", "Benchmark cell not found.");
}

/** Reverses a manual unpublish. Wrap in audited(). */
export async function republishCell(id: string): Promise<void> {
  const res = await prisma.priceBenchmark.updateMany({ where: { id, status: "unpublished" }, data: { status: "published", unpublishedReason: null, unpublishedBy: null, unpublishedAt: null } });
  if (res.count === 0) throw new DomainError("not_found", "No unpublished cell with that id.");
}
