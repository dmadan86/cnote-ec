// The ADR-023 read models. Each projection is a pure function of the event log (plus the frozen `biz:` state refs), so a
// reset + replay reproduces the same tables. Batches are aggregated in memory and flushed with upserts.
import type { Tx } from "@cnote/db";
import type { DomainEvent } from "@cnote/core";
import { dayKey, istDate, istMonth, monthsBetween } from "./time";
import { payload, type Projection } from "./types";

// ------------------------------------------------------------------------------------------- state resolver port
/** Composition root supplies this (worker wiring uses identity.getTrustProfiles). Default: every state is unknown. */
export type BusinessStateResolver = (businessIds: string[]) => Promise<Map<string, string | null>>;
let resolveStates: BusinessStateResolver = async () => new Map();
export function setBusinessStateResolver(fn: BusinessStateResolver | null) {
  resolveStates = fn ?? (async () => new Map());
}

// ------------------------------------------------------------------------------------------- refs store
interface Ref {
  categoryId: string | null;
  enquiryId: string | null;
  matchId: string | null;
  buyerBusinessId: string | null;
  sellerBusinessId: string | null;
  state: string | null;
}
const blank: Ref = { categoryId: null, enquiryId: null, matchId: null, buyerBusinessId: null, sellerBusinessId: null, state: null };

/** Per-batch cache in front of analytics_refs. */
class Refs {
  private cache = new Map<string, Ref | null>();
  constructor(private tx: Tx) {}

  async get(key: string): Promise<Ref | null> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const r = await this.tx.analyticsRef.findUnique({ where: { key } });
    const ref = r ? { categoryId: r.categoryId, enquiryId: r.enquiryId, matchId: r.matchId, buyerBusinessId: r.buyerBusinessId, sellerBusinessId: r.sellerBusinessId, state: r.state } : null;
    this.cache.set(key, ref);
    return ref;
  }

  async put(key: string, partial: Partial<Ref>) {
    const data = { ...blank, ...partial };
    await this.tx.analyticsRef.upsert({ where: { key }, create: { key, ...data }, update: data });
    this.cache.set(key, data);
  }
}

// ------------------------------------------------------------------------------------------- refs projection
export const refsProjection: Projection = {
  name: "refs",
  version: 1,
  types: ["EnquiryCreated", "LeadMatched", "ConversationStarted"],
  async process(tx, events) {
    const refs = new Refs(tx);
    for (const e of events) {
      if (e.type === "EnquiryCreated") {
        const p = payload<"EnquiryCreated">(e);
        await refs.put(`enquiry:${p.enquiryId}`, { categoryId: p.categoryId, enquiryId: p.enquiryId, buyerBusinessId: p.buyerBusinessId });
      } else if (e.type === "LeadMatched") {
        const p = payload<"LeadMatched">(e);
        const enq = await refs.get(`enquiry:${p.enquiryId}`);
        await refs.put(`match:${p.matchId}`, { categoryId: enq?.categoryId ?? null, enquiryId: p.enquiryId, matchId: p.matchId, buyerBusinessId: enq?.buyerBusinessId ?? null, sellerBusinessId: p.sellerBusinessId });
      } else if (e.type === "ConversationStarted") {
        const p = payload<"ConversationStarted">(e);
        const m = await refs.get(`match:${p.matchId}`);
        await refs.put(`conv:${p.conversationId}`, { ...(m ?? {}), matchId: p.matchId });
      }
    }
  },
  async reset(tx) {
    await tx.analyticsRef.deleteMany({ where: { NOT: { key: { startsWith: "biz:" } } } });
  },
};

// ------------------------------------------------------------------------------------------- funnel
type FunnelCol = "enquiries" | "scored" | "matched" | "accepted" | "declined" | "expired" | "refunded" | "conversations" | "quotes" | "dealsWon" | "dealsLost";

export const funnelProjection: Projection = {
  name: "funnel",
  version: 1,
  dependsOn: ["refs"],
  types: [
    "EnquiryCreated", "EnquiryScored", "LeadMatched", "LeadAccepted", "LeadDeclined", "LeadExpired", "LeadRefunded",
    "ConversationStarted", "QuoteSent", "DealReportedOffPlatform",
  ],
  async process(tx, events) {
    const refs = new Refs(tx);
    const cells = new Map<string, { day: Date; categoryId: string; inc: Partial<Record<FunnelCol, number>> }>();
    const bump = (e: DomainEvent, categoryId: string | null | undefined, col: FunnelCol) => {
      const day = istDate(e.occurredAt);
      const cat = categoryId ?? "";
      const k = `${dayKey(day)}|${cat}`;
      const cell = cells.get(k) ?? { day, categoryId: cat, inc: {} };
      cell.inc[col] = (cell.inc[col] ?? 0) + 1;
      cells.set(k, cell);
    };
    const byEnquiry = async (id: string) => (await refs.get(`enquiry:${id}`))?.categoryId;
    const byMatch = async (id: string) => (await refs.get(`match:${id}`))?.categoryId;
    for (const e of events) {
      switch (e.type) {
        case "EnquiryCreated": bump(e, payload<"EnquiryCreated">(e).categoryId, "enquiries"); break;
        case "EnquiryScored": bump(e, await byEnquiry(payload<"EnquiryScored">(e).enquiryId), "scored"); break;
        case "LeadMatched": bump(e, await byEnquiry(payload<"LeadMatched">(e).enquiryId), "matched"); break;
        case "LeadAccepted": bump(e, await byEnquiry(payload<"LeadAccepted">(e).enquiryId), "accepted"); break;
        case "LeadDeclined": bump(e, await byEnquiry(payload<"LeadDeclined">(e).enquiryId), "declined"); break;
        case "LeadExpired": bump(e, await byEnquiry(payload<"LeadExpired">(e).enquiryId), "expired"); break;
        case "LeadRefunded": bump(e, await byEnquiry(payload<"LeadRefunded">(e).enquiryId), "refunded"); break;
        case "ConversationStarted": bump(e, await byMatch(payload<"ConversationStarted">(e).matchId), "conversations"); break;
        case "QuoteSent": bump(e, (await refs.get(`conv:${payload<"QuoteSent">(e).conversationId}`))?.categoryId, "quotes"); break;
        case "DealReportedOffPlatform": {
          const p = payload<"DealReportedOffPlatform">(e);
          if (p.outcome === "won") bump(e, await byMatch(p.matchId), "dealsWon");
          else if (p.outcome === "lost") bump(e, await byMatch(p.matchId), "dealsLost");
          break;
        }
        default: break;
      }
    }
    for (const { day, categoryId, inc } of cells.values()) {
      const update = Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, { increment: v }]));
      await tx.analyticsFunnelDaily.upsert({ where: { day_categoryId: { day, categoryId } }, create: { day, categoryId, ...inc }, update });
    }
  },
  async reset(tx) {
    await tx.analyticsFunnelDaily.deleteMany();
  },
};

// ------------------------------------------------------------------------------------------- GMV
export const gmvProjection: Projection = {
  name: "gmv",
  version: 1,
  dependsOn: ["refs"],
  types: ["DealReportedOffPlatform", "OrderRecorded"],
  async process(tx, events) {
    const refs = new Refs(tx);
    const stateOf = async (businessId: string | null | undefined): Promise<string> => {
      if (!businessId) return "";
      const known = await refs.get(`biz:${businessId}`);
      if (known) return known.state ?? "";
      const state = (await resolveStates([businessId])).get(businessId) ?? null;
      await refs.put(`biz:${businessId}`, { state });
      return state ?? "";
    };
    const cells = new Map<string, { day: Date; categoryId: string; state: string; deals: number; reported: bigint; orders: number; orderGmv: bigint }>();
    const cell = (e: DomainEvent, categoryId: string | null | undefined, state: string) => {
      const day = istDate(e.occurredAt);
      const cat = categoryId ?? "";
      const k = `${dayKey(day)}|${cat}|${state}`;
      const c = cells.get(k) ?? { day, categoryId: cat, state, deals: 0, reported: 0n, orders: 0, orderGmv: 0n };
      cells.set(k, c);
      return c;
    };
    for (const e of events) {
      if (e.type === "DealReportedOffPlatform") {
        const p = payload<"DealReportedOffPlatform">(e);
        if (p.outcome !== "won") continue;
        const m = await refs.get(`match:${p.matchId}`);
        const c = cell(e, m?.categoryId, await stateOf(m?.sellerBusinessId));
        c.deals += 1;
        c.reported += BigInt(Math.max(0, Math.trunc(p.valuePaise ?? 0)));
      } else if (e.type === "OrderRecorded") {
        const p = payload<"OrderRecorded">(e);
        const enq = await refs.get(`enquiry:${p.enquiryId}`);
        const c = cell(e, enq?.categoryId, await stateOf(p.sellerBusinessId));
        c.orders += 1;
        c.orderGmv += BigInt(Math.max(0, Math.trunc(p.totalPaise ?? 0)));
      }
    }
    for (const c of cells.values()) {
      const key = { day: c.day, categoryId: c.categoryId, state: c.state };
      await tx.analyticsGmvDaily.upsert({
        where: { day_categoryId_state: key },
        create: { ...key, dealsWon: c.deals, reportedGmvPaise: c.reported, orders: c.orders, orderGmvPaise: c.orderGmv },
        update: { dealsWon: { increment: c.deals }, reportedGmvPaise: { increment: c.reported }, orders: { increment: c.orders }, orderGmvPaise: { increment: c.orderGmv } },
      });
    }
  },
  async reset(tx) {
    await tx.analyticsGmvDaily.deleteMany();
    await tx.analyticsRef.deleteMany({ where: { key: { startsWith: "biz:" } } });
  },
};

// ------------------------------------------------------------------------------------------- seller cohorts
type CohortCol = "cohortSize" | "activeSellers" | "listingsPublished" | "leadsAccepted" | "quotesSent";

export const sellerCohortProjection: Projection = {
  name: "seller_cohorts",
  version: 1,
  types: ["BusinessCreated", "ListingPublished", "LeadAccepted", "QuoteSent"],
  async process(tx, events) {
    const cells = new Map<string, { cohortMonth: Date; monthOffset: number; inc: Partial<Record<CohortCol, number>> }>();
    const bump = (cohortMonth: Date, monthOffset: number, col: CohortCol) => {
      const k = `${dayKey(cohortMonth)}|${monthOffset}`;
      const c = cells.get(k) ?? { cohortMonth, monthOffset, inc: {} };
      c.inc[col] = (c.inc[col] ?? 0) + 1;
      cells.set(k, c);
    };
    const cohorts = new Map<string, Date>();
    /** the seller's cohort; a seller first seen through an activity event (created before analytics existed) is born in that month */
    const cohortOf = async (businessId: string, at: string): Promise<Date> => {
      const cached = cohorts.get(businessId);
      if (cached) return cached;
      const month = istMonth(at);
      const created = await tx.analyticsSellerDim.createMany({ data: [{ businessId, cohortMonth: month }], skipDuplicates: true });
      const cohort = created.count ? month : (await tx.analyticsSellerDim.findUniqueOrThrow({ where: { businessId } })).cohortMonth;
      if (created.count) bump(cohort, 0, "cohortSize");
      cohorts.set(businessId, cohort);
      return cohort;
    };
    for (const e of events) {
      if (e.type === "BusinessCreated") {
        const p = payload<"BusinessCreated">(e);
        if (p.isSeller) await cohortOf(p.businessId, e.occurredAt);
        continue;
      }
      const sellerId = (e.payload as { sellerBusinessId: string }).sellerBusinessId;
      const cohort = await cohortOf(sellerId, e.occurredAt);
      const month = istMonth(e.occurredAt);
      const offset = Math.max(0, monthsBetween(cohort, month));
      const first = await tx.analyticsSellerActivity.createMany({ data: [{ businessId: sellerId, activityMonth: month }], skipDuplicates: true });
      if (first.count) bump(cohort, offset, "activeSellers");
      bump(cohort, offset, e.type === "ListingPublished" ? "listingsPublished" : e.type === "LeadAccepted" ? "leadsAccepted" : "quotesSent");
    }
    for (const { cohortMonth, monthOffset, inc } of cells.values()) {
      const update = Object.fromEntries(Object.entries(inc).map(([k, v]) => [k, { increment: v }]));
      await tx.analyticsSellerCohort.upsert({ where: { cohortMonth_monthOffset: { cohortMonth, monthOffset } }, create: { cohortMonth, monthOffset, ...inc }, update });
    }
  },
  async reset(tx) {
    await tx.analyticsSellerCohort.deleteMany();
    await tx.analyticsSellerActivity.deleteMany();
    await tx.analyticsSellerDim.deleteMany();
  },
};

/** Registration order is irrelevant (dependsOn drives ordering) but stays dependency-first for readability. */
export const PROJECTIONS: readonly Projection[] = [refsProjection, funnelProjection, gmvProjection, sellerCohortProjection];
