import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import type { DomainEventPayloads, DomainEventType } from "@cnote/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PROJECTIONS, backfill, funnelProjection, getFunnelDaily, getGmvDaily, getProjectionStatus, getSellerCohorts, gmvProjection, orderProjections, refsProjection,
  runProjection, runProjections, sellerCohortProjection, setBusinessStateResolver, withDependents, worker, projectTick, type Projection,
} from "../src";
import { run as cli } from "../src/cli";
import { latestEventId } from "../src/log";
import { istDate, istMonth, monthsBetween } from "../src/time";

// domain_events is shared by every package's tests: each test scopes itself with unique ids, its own checkpoint names and a
// checkpoint seeded at the current log head.
const id = () => randomUUID();
const DAY_A = new Date("2026-03-10T05:00:00Z"); // IST 2026-03-10 10:30
const DAY_B = new Date("2026-03-10T20:00:00Z"); // IST 2026-03-11 01:30 (crosses the IST midnight, not the UTC one)

async function emit<T extends DomainEventType>(type: T, payload: DomainEventPayloads[T], at: Date = DAY_A) {
  await prisma.domainEvent.create({ data: { type, version: 1, aggregateType: "test", aggregateId: id(), payload: payload as object, occurredAt: at } });
}

/** the real projections under unique checkpoint names, dependency edges rewired */
function suite(uid: string): Projection[] {
  const n = (s: string) => `${s}_${uid}`;
  return [
    { ...refsProjection, name: n("refs") },
    { ...funnelProjection, name: n("funnel"), dependsOn: [n("refs")] },
    { ...gmvProjection, name: n("gmv"), dependsOn: [n("refs")] },
    { ...sellerCohortProjection, name: n("cohorts") },
  ];
}
async function seed(list: Projection[]) {
  const head = await latestEventId();
  for (const p of list) await prisma.analyticsCheckpoint.upsert({ where: { projection: p.name }, create: { projection: p.name, version: p.version, lastEventId: head }, update: {} });
}
const drain = (list: Projection[]) => runProjections({ lagMs: 0, batchSize: 100 }, list);

let cat: string, e1: string, e2: string, e3: string, m1: string, s1: string, c1: string, buyer: string;
beforeEach(() => { cat = id(); e1 = id(); e2 = id(); e3 = id(); m1 = id(); s1 = id(); c1 = id(); buyer = id(); setBusinessStateResolver(null); });

async function funnelScenario() {
  await emit("EnquiryCreated", { enquiryId: e1, buyerBusinessId: buyer, categoryId: cat });
  await emit("EnquiryCreated", { enquiryId: e2, buyerBusinessId: buyer, categoryId: cat });
  await emit("EnquiryScored", { enquiryId: e1, intentScore: 80, needsReview: false });
  await emit("LeadMatched", { enquiryId: e1, matchId: m1, sellerBusinessId: s1, rank: 1, matchScore: 0.9 });
  await emit("LeadAccepted", { enquiryId: e1, matchId: m1, sellerBusinessId: s1, creditTxnId: null, responseMs: 10 });
  await emit("LeadDeclined", { enquiryId: e2, matchId: id(), sellerBusinessId: s1 });
  await emit("LeadExpired", { enquiryId: e2, matchId: id(), sellerBusinessId: s1 });
  await emit("LeadRefunded", { enquiryId: e2, matchId: id(), sellerBusinessId: s1, reason: "buyer_fake" });
  await emit("ConversationStarted", { conversationId: c1, matchId: m1 });
  await emit("QuoteSent", { quoteId: id(), conversationId: c1, sellerBusinessId: s1, pricePaise: 1000, quantity: 5 });
  await emit("DealReportedOffPlatform", { matchId: m1, reportedByBusinessId: s1, outcome: "won", valuePaise: 500_000 });
  await emit("DealReportedOffPlatform", { matchId: m1, reportedByBusinessId: s1, outcome: "lost" });
  await emit("DealReportedOffPlatform", { matchId: m1, reportedByBusinessId: s1, outcome: "pending" });
  await emit("EnquiryCreated", { enquiryId: e3, buyerBusinessId: buyer, categoryId: cat }, DAY_B);
}

describe("funnel projection", () => {
  it("counts every stage per IST day and category, attributing later events through the refs", async () => {
    const list = suite(id());
    await seed(list);
    await funnelScenario();
    await drain(list);
    const rows = await getFunnelDaily("2026-03-10", "2026-03-11", cat);
    expect(rows).toEqual([
      { day: "2026-03-10", categoryId: cat, enquiries: 2, scored: 1, matched: 1, accepted: 1, declined: 1, expired: 1, refunded: 1, conversations: 1, quotes: 1, dealsWon: 1, dealsLost: 1 },
      { day: "2026-03-11", categoryId: cat, enquiries: 1, scored: 0, matched: 0, accepted: 0, declined: 0, expired: 0, refunded: 0, conversations: 0, quotes: 0, dealsWon: 0, dealsLost: 0 },
    ]);
  });

  it("puts events whose enquiry is unknown into the unattributed ('') bucket", async () => {
    const list = suite(id());
    await seed(list);
    await emit("LeadAccepted", { enquiryId: id(), matchId: id(), sellerBusinessId: s1, creditTxnId: null, responseMs: 1 }, new Date("2025-01-05T05:00:00Z"));
    await drain(list);
    const rows = await getFunnelDaily("2025-01-05", "2025-01-05", "");
    expect(rows[0]?.accepted).toBeGreaterThanOrEqual(1);
  });
});

describe("exactly-once, resumable, replay-safe", () => {
  it("re-running does not double count, and small batches give the same result as one big batch", async () => {
    const a = suite(id());
    const b = suite(id());
    await seed(a); await seed(b);
    await funnelScenario();
    await drain(a);
    const once = await getFunnelDaily("2026-03-10", "2026-03-11", cat);
    await drain(a); await drain(a);
    expect(await getFunnelDaily("2026-03-10", "2026-03-11", cat)).toEqual(once);
    // second suite, batch of 2 events per transaction, one call at a time: doubles the same events into the same tables
    let results: Awaited<ReturnType<typeof runProjections>> = [];
    for (let i = 0; i < 60; i++) {
      results = await runProjections({ lagMs: 0, batchSize: 2, maxBatches: 1 }, b);
      if (results.every((r) => r.caughtUp)) break;
    }
    const doubled = await getFunnelDaily("2026-03-10", "2026-03-11", cat);
    expect(doubled.map((r) => r.enquiries)).toEqual(once.map((r) => r.enquiries * 2));
    expect(doubled.map((r) => r.dealsWon)).toEqual(once.map((r) => r.dealsWon * 2));
  });

  it("a failing batch rolls back both the effects and the checkpoint; the retry then applies exactly once", async () => {
    let failing = true;
    const key = id();
    const p: Projection = {
      name: `flaky_${id()}`, version: 1, types: ["EnquiryCreated"],
      async process(tx, events) {
        await tx.analyticsFunnelDaily.upsert({ where: { day_categoryId: { day: istDate(DAY_A), categoryId: key } }, create: { day: istDate(DAY_A), categoryId: key, enquiries: events.length }, update: { enquiries: { increment: events.length } } });
        if (failing) throw new Error("boom");
      },
      async reset() {},
    };
    await seed([p]);
    await emit("EnquiryCreated", { enquiryId: id(), buyerBusinessId: buyer, categoryId: cat });
    await expect(runProjection(p, { lagMs: 0 })).rejects.toThrow("boom");
    expect(await getFunnelDaily("2026-03-10", "2026-03-10", key)).toEqual([]);
    const before = (await getProjectionStatus()).find((s) => s.projection === p.name)!;
    failing = false;
    const r = await runProjection(p, { lagMs: 0 });
    expect(r.applied).toBe(1);
    expect((await getFunnelDaily("2026-03-10", "2026-03-10", key))[0]?.enquiries).toBe(1);
    expect(BigInt((await getProjectionStatus()).find((s) => s.projection === p.name)!.lastEventId)).toBeGreaterThan(BigInt(before.lastEventId));
    await runProjection(p, { lagMs: 0 });
    expect((await getFunnelDaily("2026-03-10", "2026-03-10", key))[0]?.enquiries).toBe(1);
  });

  it("two workers racing on one projection never double apply (row lock, SKIP LOCKED)", async () => {
    const list = suite(id());
    await seed(list);
    await funnelScenario();
    const f = list[1]!;
    await runProjection(list[0]!, { lagMs: 0 });
    const results = await Promise.all([runProjection(f, { lagMs: 0 }), runProjection(f, { lagMs: 0 }), runProjection(f, { lagMs: 0 })]);
    expect(results.reduce((n, r) => n + r.applied, 0)).toBe(14); // every event of a funnel type counts as applied, even when it only bumps one column
    const rows = await getFunnelDaily("2026-03-10", "2026-03-11", cat);
    expect(rows.reduce((n, r) => n + r.enquiries, 0)).toBe(3);
  });

  it("respects the safety lag: recent events wait until they are old enough", async () => {
    const list = suite(id());
    await seed(list);
    await emit("EnquiryCreated", { enquiryId: id(), buyerBusinessId: buyer, categoryId: cat }, new Date());
    expect((await runProjection(list[0]!, { lagMs: 60_000 })).applied).toBe(0);
    const later = await runProjection(list[0]!, { lagMs: 60_000, now: () => new Date(Date.now() + 120_000) });
    expect(later.applied).toBe(1);
  });

  it("a dependent projection never passes its dependency's checkpoint", async () => {
    const list = suite(id());
    await seed(list);
    await emit("EnquiryCreated", { enquiryId: e1, buyerBusinessId: buyer, categoryId: cat });
    const r = await runProjection(list[1]!, { lagMs: 0 }); // refs has not run: cap = its (seeded) checkpoint
    expect(r).toMatchObject({ applied: 0, caughtUp: true });
    await runProjection(list[0]!, { lagMs: 0 });
    expect((await runProjection(list[1]!, { lagMs: 0 })).applied).toBe(1);
  });

  it("refuses to run when the tables were built by another projection version", async () => {
    const list = suite(id());
    await seed(list);
    await prisma.analyticsCheckpoint.update({ where: { projection: list[0]!.name }, data: { version: 99 } });
    await expect(runProjection(list[0]!, { lagMs: 0 })).rejects.toThrow(/backfill --reset/);
  });

  it("backfill --reset rebuilds identical tables from event 0 and cascades to dependents", async () => {
    const list = suite(id());
    await seed(list);
    await funnelScenario();
    await drain(list);
    const before = await getFunnelDaily("2026-03-10", "2026-03-11", cat);
    expect(before.length).toBe(2);
    const results = await backfill({ projections: [list[0]!.name], reset: true }, list);
    expect(results.map((r) => r.projection)).toEqual(list.filter((p) => p.name !== list[3]!.name).map((p) => p.name)); // refs + funnel + gmv, not cohorts
    expect(await getFunnelDaily("2026-03-10", "2026-03-11", cat)).toEqual(before);
    // full drain without reset is a no-op on an up-to-date read model
    await backfill({}, list);
    expect(await getFunnelDaily("2026-03-10", "2026-03-11", cat)).toEqual(before);
    await expect(backfill({ projections: ["nope"] }, list)).rejects.toThrow(/unknown analytics projection/);
  });
});

describe("gmv projection", () => {
  it("attributes reported wins and orders to category and the seller's state, resolving each business once and freezing it", async () => {
    const list = suite(id());
    await seed(list);
    const resolver = vi.fn(async (ids: string[]) => new Map(ids.map((i) => [i, "Karnataka"])));
    setBusinessStateResolver(resolver);
    await emit("EnquiryCreated", { enquiryId: e1, buyerBusinessId: buyer, categoryId: cat });
    await emit("LeadMatched", { enquiryId: e1, matchId: m1, sellerBusinessId: s1, rank: 1, matchScore: 1 });
    await emit("DealReportedOffPlatform", { matchId: m1, reportedByBusinessId: s1, outcome: "won", valuePaise: 500_000 });
    await emit("DealReportedOffPlatform", { matchId: m1, reportedByBusinessId: s1, outcome: "won" }); // no value: counted, adds no GMV
    await emit("DealReportedOffPlatform", { matchId: m1, reportedByBusinessId: s1, outcome: "lost", valuePaise: 999 });
    await emit("OrderRecorded", { orderId: id(), matchId: m1, enquiryId: e1, buyerBusinessId: buyer, sellerBusinessId: s1, totalPaise: 250_000 });
    await emit("OrderRecorded", { orderId: id(), matchId: m1, enquiryId: e1, buyerBusinessId: buyer, sellerBusinessId: s1, totalPaise: null });
    await drain(list);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(await getGmvDaily("2026-03-10", "2026-03-10", { categoryId: cat })).toEqual([
      { day: "2026-03-10", categoryId: cat, state: "Karnataka", dealsWon: 2, reportedGmvPaise: 500_000, orders: 2, orderGmvPaise: 250_000 },
    ]);
    // the state is frozen at first resolution: a later change of address does not split history on replay
    setBusinessStateResolver(async (ids) => new Map(ids.map((i) => [i, "Goa"])));
    await emit("DealReportedOffPlatform", { matchId: m1, reportedByBusinessId: s1, outcome: "won", valuePaise: 100 }, new Date("2026-03-10T06:00:00Z"));
    await drain(list);
    const rows = await getGmvDaily("2026-03-10", "2026-03-10", { categoryId: cat });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "Karnataka", reportedGmvPaise: 500_100 });
    expect(await getGmvDaily("2026-03-10", "2026-03-10", { categoryId: cat, state: "Goa" })).toEqual([]);
  });

  it("unknown state and unknown match land in the '' buckets", async () => {
    const list = suite(id());
    await seed(list);
    await emit("DealReportedOffPlatform", { matchId: id(), reportedByBusinessId: s1, outcome: "won", valuePaise: 7 }, new Date("2025-02-01T05:00:00Z"));
    await emit("OrderRecorded", { orderId: id(), matchId: id(), enquiryId: id(), buyerBusinessId: buyer, sellerBusinessId: s1, totalPaise: 9 }, new Date("2025-02-01T05:00:00Z"));
    await drain(list);
    const rows = await getGmvDaily("2025-02-01", "2025-02-01", { categoryId: "", state: "" });
    expect(rows[0]!.reportedGmvPaise).toBeGreaterThanOrEqual(7);
    expect(rows[0]!.orderGmvPaise).toBeGreaterThanOrEqual(9);
  });
});

describe("seller cohorts", () => {
  it("counts each seller once per activity month, by months since the cohort month", async () => {
    const list = suite(id());
    await seed(list);
    // cohort cells are shared by every run in this database: assert on deltas
    const before = await getSellerCohorts("2025-01", "2025-03");
    const seller = id(), lateSeller = id(), buyerOnly = id();
    const jan = new Date("2025-01-15T05:00:00Z"), mar = new Date("2025-03-02T05:00:00Z");
    await emit("BusinessCreated", { businessId: seller, personId: id(), isSeller: true }, jan);
    await emit("BusinessCreated", { businessId: buyerOnly, personId: id(), isSeller: false }, jan);
    await emit("ListingPublished", { listingId: id(), sellerBusinessId: seller, categoryId: cat }, jan);
    await emit("ListingPublished", { listingId: id(), sellerBusinessId: seller, categoryId: cat }, jan);
    await emit("LeadAccepted", { enquiryId: id(), matchId: id(), sellerBusinessId: seller, creditTxnId: null, responseMs: 1 }, mar);
    await emit("QuoteSent", { quoteId: id(), conversationId: id(), sellerBusinessId: seller, pricePaise: 1, quantity: 1 }, mar);
    await emit("ListingPublished", { listingId: id(), sellerBusinessId: lateSeller, categoryId: cat }, mar); // first seen through activity: born in March
    await drain(list);
    const after = await getSellerCohorts("2025-01", "2025-03");
    const d = (m: string, o: number, k: "cohortSize" | "activeSellers" | "listingsPublished" | "leadsAccepted" | "quotesSent") =>
      (after.find((r) => r.cohortMonth === m && r.monthOffset === o)?.[k] ?? 0) - (before.find((r) => r.cohortMonth === m && r.monthOffset === o)?.[k] ?? 0);
    expect(d("2025-01", 0, "cohortSize")).toBe(1); // the buyer-only business is not a seller
    expect(d("2025-01", 0, "activeSellers")).toBe(1); // two listings in January, counted once
    expect(d("2025-01", 0, "listingsPublished")).toBe(2);
    expect(d("2025-01", 2, "activeSellers")).toBe(1);
    expect(d("2025-01", 2, "leadsAccepted")).toBe(1);
    expect(d("2025-01", 2, "quotesSent")).toBe(1);
    expect(d("2025-01", 2, "listingsPublished")).toBe(0);
    expect(d("2025-03", 0, "cohortSize")).toBe(1);
    expect(d("2025-03", 0, "listingsPublished")).toBe(1);
    expect(await getSellerCohorts()).not.toHaveLength(0);
  });
});

describe("orchestration helpers", () => {
  it("orders projections dependency-first and rejects unknown or cyclic dependencies", () => {
    expect(orderProjections().map((p) => p.name)).toEqual(["refs", "funnel", "gmv", "seller_cohorts"]);
    const a: Projection = { ...funnelProjection, name: "a", dependsOn: ["b"] };
    const b: Projection = { ...funnelProjection, name: "b", dependsOn: ["a"] };
    expect(() => orderProjections([a, b])).toThrow(/cycle/);
    expect(() => orderProjections([{ ...a, dependsOn: ["zzz"] }])).toThrow(/unknown projection zzz/);
    expect(withDependents(["refs"])).toEqual(["refs", "funnel", "gmv"]);
    expect(withDependents(["seller_cohorts"])).toEqual(["seller_cohorts"]);
    expect(PROJECTIONS).toHaveLength(4);
  });

  it("the worker registers one scheduled projection job and no event handlers", async () => {
    expect(worker.name).toBe("analytics");
    expect(Object.keys(worker.handlers)).toHaveLength(0);
    expect(worker.jobs.map((j) => j.name)).toEqual(["analytics.project"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.jobs[0]!.run();
    expect(await projectTick()).toBeGreaterThanOrEqual(0);
    log.mockRestore();
  });

  it("reports status and drives the backfill CLI", async () => {
    const list = suite(id());
    await seed(list);
    const status = await getProjectionStatus();
    expect(status.find((s) => s.projection === list[0]!.name)).toMatchObject({ version: 1, lagEvents: expect.any(String) });
    const lines: string[] = [];
    await cli(["--status"], (l) => lines.push(l));
    expect(lines.some((l) => l.startsWith(list[0]!.name))).toBe(true);
  });

  it("time helpers bucket by IST calendar day and month", () => {
    expect(istDate("2026-03-10T20:00:00Z").toISOString()).toBe("2026-03-11T00:00:00.000Z");
    expect(istDate(new Date("2026-03-10T05:00:00Z")).toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(istMonth("2026-03-31T20:00:00Z").toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(monthsBetween(new Date("2026-11-01T00:00:00Z"), new Date("2027-02-01T00:00:00Z"))).toBe(3);
  });
});
