import { prisma } from "@cnote/db";
import { cachedTagged, cacheTags, DomainError, invalidateTags } from "@cnote/core";
import type { PlanView } from "./types";

const DEFAULT_PLANS = [
  {
    code: "free", name: "Free", monthlyPricePaise: 0n, monthlyCredits: 10, sortOrder: 0,
    features: ["Verified business listing", "10 lead credits every month", "Intent score visible on every lead", "Reply in-app or on WhatsApp"],
  },
  {
    code: "starter", name: "Starter", monthlyPricePaise: 99_900n, monthlyCredits: 60, sortOrder: 1,
    features: ["60 lead credits every month", "Everything in Free", "Basic analytics", "Credits roll over for 90 days"],
  },
  {
    code: "pro", name: "Pro", monthlyPricePaise: 299_900n, monthlyCredits: 250, sortOrder: 2,
    features: ["250 lead credits every month", "Everything in Starter", "Advanced analytics and response insights", "Priority support"],
  },
];

/** Idempotent upsert of the default plans. Never touches subscriptions. */
export async function seedPlans(): Promise<void> {
  for (const p of DEFAULT_PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      create: p,
      update: { name: p.name, monthlyPricePaise: p.monthlyPricePaise, monthlyCredits: p.monthlyCredits, features: p.features, sortOrder: p.sortOrder },
    });
  }
  await invalidateTags([cacheTags.plans]);
}

type PlanRow = { code: string; name: string; monthlyPricePaise: bigint; monthlyCredits: number; features: unknown };
export function toPlanView(p: PlanRow): PlanView {
  return {
    code: p.code,
    name: p.name,
    monthlyPricePaise: Number(p.monthlyPricePaise),
    monthlyCredits: p.monthlyCredits,
    features: Array.isArray(p.features) ? (p.features as string[]) : [],
  };
}

/** Public plan catalogue (pricing pages, onboarding). Cached 10 min + SWR; `seedPlans` invalidates. */
export async function listPlans(): Promise<PlanView[]> {
  return cachedTagged("billing:plans:v1", [cacheTags.plans], 600, loadPlans, { staleSeconds: 3600 });
}

async function loadPlans(): Promise<PlanView[]> {
  let rows = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });
  if (rows.length === 0) {
    await seedPlans();
    rows = await prisma.plan.findMany({ orderBy: { sortOrder: "asc" } });
  }
  return rows.map(toPlanView);
}

export async function getPlan(code: string): Promise<PlanView> {
  let row = await prisma.plan.findUnique({ where: { code } });
  if (!row && DEFAULT_PLANS.some((p) => p.code === code)) {
    await seedPlans();
    row = await prisma.plan.findUnique({ where: { code } });
  }
  if (!row) throw new DomainError("not_found", "Plan not found");
  return toPlanView(row);
}
