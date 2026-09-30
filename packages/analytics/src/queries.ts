import { prisma } from "@cnote/db";
import { dayKey } from "./time";

const dayRange = (from: string, to: string) => ({ gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) });

export interface FunnelRow {
  day: string; categoryId: string; enquiries: number; scored: number; matched: number; accepted: number; declined: number; expired: number;
  refunded: number; conversations: number; quotes: number; dealsWon: number; dealsLost: number;
}

/** Daily funnel facts for IST days [from, to] (YYYY-MM-DD), optionally one category ("" = unattributed). */
export async function getFunnelDaily(from: string, to: string, categoryId?: string): Promise<FunnelRow[]> {
  const rows = await prisma.analyticsFunnelDaily.findMany({ where: { day: dayRange(from, to), ...(categoryId !== undefined ? { categoryId } : {}) }, orderBy: [{ day: "asc" }, { categoryId: "asc" }] });
  return rows.map(({ day, ...r }) => ({ day: dayKey(day), ...r }));
}

export interface GmvRow { day: string; categoryId: string; state: string; dealsWon: number; reportedGmvPaise: number; orders: number; orderGmvPaise: number }

/** GMV facts (paise, converted with Number() at the module boundary per CLAUDE.md) for IST days [from, to]. */
export async function getGmvDaily(from: string, to: string, filter: { categoryId?: string; state?: string } = {}): Promise<GmvRow[]> {
  const rows = await prisma.analyticsGmvDaily.findMany({
    where: { day: dayRange(from, to), ...(filter.categoryId !== undefined ? { categoryId: filter.categoryId } : {}), ...(filter.state !== undefined ? { state: filter.state } : {}) },
    orderBy: [{ day: "asc" }, { categoryId: "asc" }, { state: "asc" }],
  });
  return rows.map((r) => ({ day: dayKey(r.day), categoryId: r.categoryId, state: r.state, dealsWon: r.dealsWon, reportedGmvPaise: Number(r.reportedGmvPaise), orders: r.orders, orderGmvPaise: Number(r.orderGmvPaise) }));
}

export interface CohortRow { cohortMonth: string; monthOffset: number; cohortSize: number; activeSellers: number; listingsPublished: number; leadsAccepted: number; quotesSent: number }

export async function getSellerCohorts(fromMonth?: string, toMonth?: string): Promise<CohortRow[]> {
  const rows = await prisma.analyticsSellerCohort.findMany({
    where: fromMonth || toMonth ? { cohortMonth: { ...(fromMonth ? { gte: new Date(`${fromMonth}-01T00:00:00Z`) } : {}), ...(toMonth ? { lte: new Date(`${toMonth}-01T00:00:00Z`) } : {}) } } : {},
    orderBy: [{ cohortMonth: "asc" }, { monthOffset: "asc" }],
  });
  return rows.map(({ cohortMonth, ...r }) => ({ cohortMonth: dayKey(cohortMonth).slice(0, 7), ...r }));
}
