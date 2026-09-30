// Public rate card (Phase 1.5): a fixed CPC per category and surface, versioned by effectiveFrom so a change never
// rewrites what an advertiser was shown or charged. Set by staff with ads.settings (caller wraps in audited()).
import { getCategoryById, listCategories } from "@cnote/catalogue";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";

export interface RateRow {
  id: string;
  categoryId: string | null;
  surface: string;
  cpcPaise: number;
  maxCpcPaise: number | null;
  effectiveFrom: Date;
}

/** Nearest category (self first, then ancestors, then the platform default) with a row in force at `at` wins; latest effectiveFrom per scope. */
export function resolveRate(rows: RateRow[], chain: string[], surface: string, at: Date): { id: string; cpcPaise: number } | null {
  for (const scope of [...chain, null]) {
    const inForce = rows
      .filter((r) => r.categoryId === scope && r.surface === surface && r.effectiveFrom.getTime() <= at.getTime())
      .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime() || (a.id < b.id ? 1 : -1));
    const r = inForce[0];
    if (r) return { id: r.id, cpcPaise: Math.min(r.cpcPaise, r.maxCpcPaise ?? Number.MAX_SAFE_INTEGER) };
  }
  return null;
}

export async function loadRateRows(): Promise<RateRow[]> {
  const rows = await prisma.adRateCard.findMany();
  return rows.map((r) => ({ id: r.id, categoryId: r.categoryId, surface: r.surface, cpcPaise: Number(r.cpcPaise), maxCpcPaise: r.maxCpcPaise === null ? null : Number(r.maxCpcPaise), effectiveFrom: r.effectiveFrom }));
}

export async function categoryChains(): Promise<Map<string, string[]>> {
  const cats = await listCategories();
  const byId = new Map(cats.map((c) => [c.id, c]));
  const chains = new Map<string, string[]>();
  for (const c of cats) {
    const chain: string[] = [];
    let cur: string | null = c.id;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = byId.get(cur)?.parentId ?? null;
    }
    chains.set(c.id, chain);
  }
  return chains;
}

const rateInput = z.object({
  categoryId: z.uuid().nullable(),
  surface: z.enum(["search", "category", "product_similar"]),
  cpcPaise: z.number().int().min(100, "CPC must be at least Rs 1").max(1_000_000),
  maxCpcPaise: z.number().int().min(100).max(1_000_000).nullable().optional(),
  effectiveFrom: z.coerce.date().optional(),
});

export async function setRateCard(input: z.input<typeof rateInput>, staffId: string | null, now = new Date()) {
  const p = rateInput.safeParse(input);
  if (!p.success) throw new DomainError("validation", p.error.issues[0]?.message ?? "Invalid rate", p.error.issues);
  const d = p.data;
  if (d.maxCpcPaise != null && d.maxCpcPaise < d.cpcPaise) throw new DomainError("validation", "Max CPC cannot be below the CPC", undefined, "ads.maxCpcBelowCpc");
  if (d.categoryId && !(await getCategoryById(d.categoryId))) throw new DomainError("validation", "Unknown category", undefined, "ads.unknownCategory");
  const row = await prisma.adRateCard.create({
    data: {
      categoryId: d.categoryId,
      surface: d.surface,
      pricingModel: "rate_card",
      cpcPaise: BigInt(d.cpcPaise),
      maxCpcPaise: d.maxCpcPaise == null ? null : BigInt(d.maxCpcPaise),
      effectiveFrom: d.effectiveFrom ?? now,
      createdBy: staffId,
    },
  });
  return { id: row.id };
}

export interface RateCardEntry {
  categoryId: string | null;
  categoryName: string;
  surface: string;
  cpcPaise: number;
  maxCpcPaise: number | null;
  effectiveFrom: string;
}

/** The public price list: the row in force now per (category, surface). Rows with a future effectiveFrom are not shown until then. */
export async function getPublicRateCard(now = new Date()): Promise<RateCardEntry[]> {
  const rows = (await loadRateRows()).filter((r) => r.effectiveFrom.getTime() <= now.getTime());
  const latest = new Map<string, RateRow>();
  for (const r of rows) {
    const k = `${r.categoryId ?? "-"}|${r.surface}`;
    const cur = latest.get(k);
    if (!cur || r.effectiveFrom.getTime() > cur.effectiveFrom.getTime()) latest.set(k, r);
  }
  const names = new Map((await listCategories()).map((c) => [c.id, c.name]));
  return [...latest.values()]
    .map((r) => ({
      categoryId: r.categoryId,
      categoryName: r.categoryId ? (names.get(r.categoryId) ?? "Category") : "All categories (default)",
      surface: r.surface,
      cpcPaise: Math.min(r.cpcPaise, r.maxCpcPaise ?? Number.MAX_SAFE_INTEGER),
      maxCpcPaise: r.maxCpcPaise,
      effectiveFrom: r.effectiveFrom.toISOString(),
    }))
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName) || a.surface.localeCompare(b.surface));
}
