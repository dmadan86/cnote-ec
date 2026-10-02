import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertCategories } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { DomainError } from "@cnote/core";
import {
  addChecklistItem, blockingVerticals, changeStage, checklistProgress, createVertical, createVerticalFromTemplate, deleteChecklistItem, evaluateVerticalGates,
  getVerticalForCategory, listCandidateRoots, listChecklist, listOpenVerticals, listSnapshots, listStageChanges, listVerticals, PLAYBOOK_TEMPLATE, setVerticalStatsPort,
  snapshotAllVerticals, snapshotVertical, updateChecklistItem, updateVertical, worker, getVertical, getVerticalBySlug,
} from "../src/index";

const tag = randomUUID().slice(0, 6);
const cat = (s: string) => `vt-${tag}-${s}`;
const counts = new Map<string, number>();
const DAY = 86_400_000;
const ids: string[] = [];
const staff = "staff-1";

async function mk(name: string, cats: string[], gates = {}) {
  const v = await createVertical({ slug: `v-${tag}-${name}`, name, categorySlugs: cats.map(cat), gates });
  ids.push(v.id);
  return v;
}
/** put a snapshot `daysBack` days ago */
const seedSnap = (verticalId: string, daysBack: number, verifiedSellers: number) =>
  prisma.verticalMetricSnapshot.create({ data: { verticalId, day: new Date(new Date(Date.now() + 5.5 * 3_600_000 - daysBack * DAY).toISOString().slice(0, 10) + "T00:00:00Z"), verifiedSellers, meetsGates: false } });

beforeAll(async () => {
  await upsertCategories([
    { slug: cat("root"), name: "Root" }, { slug: cat("child"), name: "Child", parentSlug: cat("root") },
    { slug: cat("a"), name: "A" }, { slug: cat("b"), name: "B" }, { slug: cat("c"), name: "C" },
  ]);
  setVerticalStatsPort({ countVerifiedSellers: async (slugs) => slugs.reduce((n, s) => n + (counts.get(s) ?? 0), 0) });
});
beforeEach(async () => {
  counts.clear();
  await prisma.vertical.deleteMany({ where: { id: { in: ids } } });
  await prisma.vertical.deleteMany({ where: { stage: "open" } }); // isolated test DB: no foreign open verticals may leak in
  ids.length = 0;
});
afterAll(async () => {
  setVerticalStatsPort(null);
  await prisma.domainEvent.deleteMany({ where: { type: "VerticalStageChanged", payload: { path: ["slug"], string_contains: tag } } });
  await prisma.vertical.deleteMany({ where: { slug: { contains: tag } } });
  // tolerate a foreign draft: draftListingFromText/Photos fall back to the first category in the DB, so a parallel file may still reference this one
  await prisma.category.deleteMany({ where: { slug: { startsWith: `vt-${tag}` } } }).catch(() => {});
});

describe("config", () => {
  it("creates a candidate with defaults and validates input", async () => {
    const v = await mk("basic", ["a"]);
    expect(v).toMatchObject({ stage: "candidate", languages: ["en", "hi"], gates: { minVerifiedSellers: 200, minNetAdds30: 1, minNetAdds90: 1 } });
    await expect(createVertical({ slug: v.slug, name: "dup", categorySlugs: [cat("a")] })).rejects.toMatchObject({ code: "conflict" });
    await expect(createVertical({ slug: "Bad Slug", name: "x", categorySlugs: [cat("a")] })).rejects.toMatchObject({ code: "validation" });
    await expect(createVertical({ slug: `v-${tag}-x`, name: "xx", categorySlugs: ["no-such-category"] })).rejects.toMatchObject({ code: "validation", message: /no-such-category/ });
    await expect(createVertical({ slug: `v-${tag}-y`, name: "yy", categorySlugs: [cat("a")], languages: ["en", "en"] })).rejects.toMatchObject({ code: "validation" });
    await expect(createVertical({ slug: `v-${tag}-z`, name: "zz", categorySlugs: [cat("a")], languages: ["xx" as "en"] })).rejects.toBeInstanceOf(DomainError);
  });
  it("updates fields and merges gates", async () => {
    const v = await mk("upd", ["a"]);
    const u = await updateVertical(v.id, { name: "Renamed", languages: ["ta", "en"], gates: { minVerifiedSellers: 50 }, clusters: [{ label: "Tiruppur knitwear", city: "Tiruppur", industry: "knitwear" }], classifierConfig: { prohibitedModelVersion: "p-2" }, notes: "n", attributeSchemaSlug: cat("b"), categorySlugs: [cat("a"), cat("b")] });
    expect(u).toMatchObject({ name: "Renamed", languages: ["ta", "en"], gates: { minVerifiedSellers: 50, minNetAdds30: 1 }, notes: "n", attributeSchemaSlug: cat("b") });
    expect(u.clusters[0]!.label).toBe("Tiruppur knitwear");
    await expect(updateVertical(randomUUID(), { name: "zz" })).rejects.toMatchObject({ code: "not_found" });
    await expect(updateVertical(v.id, { categorySlugs: ["nope"] })).rejects.toMatchObject({ code: "validation" });
    expect((await getVertical(v.id))?.name).toBe("Renamed");
    expect((await getVerticalBySlug(v.slug))?.id).toBe(v.id);
    expect(await getVertical(randomUUID())).toBeNull();
    expect((await listVerticals()).some((x) => x.id === v.id)).toBe(true);
  });
});

describe("checklist", () => {
  it("adds, updates, orders, deletes and reports progress", async () => {
    const v = await mk("cl", ["a"]);
    const a = await addChecklistItem(v.id, { section: "ops", title: "Staff the queue", owner: " Asha " });
    const b = await addChecklistItem(v.id, { section: "schema", title: "Define schema" });
    const c = await addChecklistItem(v.id, { section: "schema", title: "Second schema step" });
    expect(a.owner).toBe("Asha");
    expect(c.sortOrder).toBe(1);
    expect((await listChecklist(v.id)).map((i) => i.title)).toEqual(["Define schema", "Second schema step", "Staff the queue"]);
    const done = await updateChecklistItem(b.id, { done: true, evidenceUrl: "https://example.com/e", owner: "Ravi" });
    expect(done).toMatchObject({ done: true, evidenceUrl: "https://example.com/e", owner: "Ravi" });
    expect(done.doneAt).not.toBeNull();
    const again = await updateChecklistItem(b.id, { done: true, title: "Renamed step" });
    expect(again.doneAt).toBe(done.doneAt);
    expect((await updateChecklistItem(b.id, { done: false, evidenceUrl: "", owner: null })).doneAt).toBeNull();
    await expect(updateChecklistItem(b.id, { evidenceUrl: "javascript:alert(1)" })).rejects.toMatchObject({ code: "validation" });
    await expect(updateChecklistItem(b.id, { title: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(updateChecklistItem(randomUUID(), { done: true })).rejects.toMatchObject({ code: "not_found" });
    await updateChecklistItem(a.id, { done: true });
    const p = await checklistProgress(v.id);
    expect(p).toMatchObject({ done: 1, total: 3 });
    expect(p.bySection.schema).toEqual({ done: 0, total: 2 });
    await deleteChecklistItem(c.id);
    expect((await listChecklist(v.id)).length).toBe(2);
    await expect(addChecklistItem(v.id, { section: "nope" as "ops", title: "abc" })).rejects.toMatchObject({ code: "validation" });
    await expect(addChecklistItem(v.id, { section: "ops", title: " " })).rejects.toMatchObject({ code: "validation" });
    await expect(addChecklistItem(randomUUID(), { section: "ops", title: "abc" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("gates", () => {
  it("counts verified sellers through the port and expands categories", async () => {
    const v = await mk("g1", ["a"], { minVerifiedSellers: 5 });
    counts.set(cat("a"), 5);
    const r = await evaluateVerticalGates(v.id);
    expect(r).toMatchObject({ verifiedSellers: 5, netAdds30: null, netAdds90: null });
    expect(r.checks).toEqual({ verifiedSellers: true, netAdds30: false, netAdds90: false });
    expect(r.meetsGates).toBe(false); // no history yet
    await expect(evaluateVerticalGates(randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
  it("computes net adds from snapshots (full and partial windows)", async () => {
    const v = await mk("g2", ["a"], { minVerifiedSellers: 10 });
    await seedSnap(v.id, 95, 4); // baseline for 90d
    await seedSnap(v.id, 31, 8); // baseline for 30d
    await seedSnap(v.id, 5, 9);
    counts.set(cat("a"), 12);
    const r = await evaluateVerticalGates(v.id);
    expect(r).toMatchObject({ verifiedSellers: 12, netAdds30: 4, netAdds90: 8, baselineDays30: 31, baselineDays90: 95 });
    expect(r.meetsGates).toBe(true);
    counts.set(cat("a"), 8); // shrinking
    const shrink = await evaluateVerticalGates(v.id);
    expect(shrink).toMatchObject({ netAdds30: 0, netAdds90: 4 });
    expect(shrink.checks).toMatchObject({ verifiedSellers: false, netAdds30: false, netAdds90: true });

    const p = await mk("g3", ["b"], { minVerifiedSellers: 1 });
    await seedSnap(p.id, 10, 2); // only partial history: used as baseline for both
    counts.set(cat("b"), 3);
    expect(await evaluateVerticalGates(p.id)).toMatchObject({ netAdds30: 1, netAdds90: 1, baselineDays30: 10, meetsGates: true });
  });
  it("snapshots idempotently and lists the trend", async () => {
    const v = await mk("g4", ["a"]);
    counts.set(cat("a"), 3);
    await snapshotVertical(v.id);
    counts.set(cat("a"), 4);
    await snapshotVertical(v.id);
    const s = await listSnapshots(v.id);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ verifiedSellers: 4, meetsGates: false });
    expect(await snapshotAllVerticals()).toBeGreaterThanOrEqual(1);
  });
  it("the worker job snapshots every vertical and survives a failing one", async () => {
    const v = await mk("g5", ["a"]);
    counts.set(cat("a"), 2);
    const job = worker.jobs.find((j) => j.name === "verticals.snapshot-gates")!;
    await job.run();
    expect((await listSnapshots(v.id))[0]?.verifiedSellers).toBe(2);
    setVerticalStatsPort({ countVerifiedSellers: async () => { throw new Error("boom"); } });
    const err = console.error;
    console.error = () => {};
    try {
      expect(await snapshotAllVerticals()).toBe(0);
    } finally {
      console.error = err;
      setVerticalStatsPort({ countVerifiedSellers: async (slugs) => slugs.reduce((n, s) => n + (counts.get(s) ?? 0), 0) });
    }
  });
});

describe("stage changes (ADR-016)", () => {
  const healthy = async (v: { id: string }, slug: string) => {
    counts.set(cat(slug), 10);
    await seedSnap(v.id, 40, 1);
  };

  it("enforces the transition graph and emits VerticalStageChanged", async () => {
    const v = await mk("s1", ["a"]);
    await expect(changeStage({ verticalId: v.id, to: "open", changedBy: staff })).rejects.toMatchObject({ code: "validation" });
    await expect(changeStage({ verticalId: v.id, to: "candidate", changedBy: staff })).rejects.toMatchObject({ code: "conflict" });
    await expect(changeStage({ verticalId: randomUUID(), to: "pilot", changedBy: staff })).rejects.toMatchObject({ code: "not_found" });
    const r = await changeStage({ verticalId: v.id, to: "pilot", changedBy: staff });
    expect(r).toMatchObject({ overridden: false, blockedBy: [], vertical: { stage: "pilot" } });
    const ev = await prisma.domainEvent.findFirst({ where: { type: "VerticalStageChanged", aggregateId: v.id } });
    expect(ev?.payload).toEqual({ verticalId: v.id, slug: v.slug, from: "candidate", to: "pilot", changedBy: staff });
    const log = await listStageChanges(v.id);
    expect(log[0]).toMatchObject({ from: "candidate", to: "pilot", overridden: false });
  });

  it("allows the first launch and pilot->open with no open vertical", async () => {
    const v = await mk("s2", ["a"]);
    await changeStage({ verticalId: v.id, to: "pilot", changedBy: staff });
    expect((await changeStage({ verticalId: v.id, to: "open", changedBy: staff })).vertical.stage).toBe("open");
    expect((await listOpenVerticals()).map((x) => x.id)).toContain(v.id);
  });

  it("blocks a new vertical while an open one fails its gates, and explains why", async () => {
    const open = await mk("s3", ["a"], { minVerifiedSellers: 200 });
    await prisma.vertical.update({ where: { id: open.id }, data: { stage: "open" } });
    counts.set(cat("a"), 50);
    const next = await mk("s4", ["b"]);
    const err = await changeStage({ verticalId: next.id, to: "pilot", changedBy: staff }).catch((e) => e);
    expect(err).toMatchObject({ code: "conflict", message: /ADR-016/ });
    expect((err.details as { blockedBy: { slug: string }[] }).blockedBy[0]!.slug).toBe(open.slug);
    expect((await blockingVerticals()).map((b) => b.slug)).toEqual([open.slug]);
    expect((await getVertical(next.id))?.stage).toBe("candidate");
    expect(await prisma.domainEvent.count({ where: { type: "VerticalStageChanged", aggregateId: next.id } })).toBe(0);
  });

  it("allows the launch when every open vertical meets its gates", async () => {
    const open = await mk("s5", ["a"], { minVerifiedSellers: 10 });
    await prisma.vertical.update({ where: { id: open.id }, data: { stage: "open" } });
    await healthy(open, "a");
    const next = await mk("s6", ["b"]);
    expect((await changeStage({ verticalId: next.id, to: "pilot", changedBy: staff })).overridden).toBe(false);
    // a second candidate can also launch straight away, and pilot->open is gated too
    expect((await changeStage({ verticalId: next.id, to: "open", changedBy: staff })).vertical.stage).toBe("open");
  });

  it("gates pilot->open and resuming from paused", async () => {
    const open = await mk("s7", ["a"], { minVerifiedSellers: 200 });
    await prisma.vertical.update({ where: { id: open.id }, data: { stage: "open" } });
    const p = await mk("s8", ["b"]);
    await prisma.vertical.update({ where: { id: p.id }, data: { stage: "pilot" } });
    await expect(changeStage({ verticalId: p.id, to: "open", changedBy: staff })).rejects.toMatchObject({ code: "conflict" });
    await changeStage({ verticalId: p.id, to: "paused", changedBy: staff }); // pausing is never blocked
    await expect(changeStage({ verticalId: p.id, to: "pilot", changedBy: staff })).rejects.toMatchObject({ code: "conflict" });
    await changeStage({ verticalId: p.id, to: "candidate", changedBy: staff }); // demotion is never blocked
  });

  it("requires a real reason for an override and records it", async () => {
    const open = await mk("s9", ["a"]);
    await prisma.vertical.update({ where: { id: open.id }, data: { stage: "open" } });
    const next = await mk("s10", ["b"]);
    await expect(changeStage({ verticalId: next.id, to: "pilot", changedBy: staff, override: { reason: "short" } })).rejects.toMatchObject({ code: "validation" });
    await expect(changeStage({ verticalId: next.id, to: "pilot", changedBy: staff, override: { reason: "   " } })).rejects.toMatchObject({ code: "validation" });
    const r = await changeStage({ verticalId: next.id, to: "pilot", changedBy: staff, override: { reason: "  Board approved a pilot on 2026-10-01  " } });
    expect(r).toMatchObject({ overridden: true, vertical: { stage: "pilot" } });
    expect(r.blockedBy.map((b) => b.slug)).toEqual([open.slug]);
    const log = (await listStageChanges(next.id))[0]!;
    expect(log).toMatchObject({ overridden: true, overrideReason: "Board approved a pilot on 2026-10-01" });
    expect(JSON.stringify(log.gateSnapshot)).toContain(open.slug);
  });

  it("an unnecessary override is ignored (not recorded as one)", async () => {
    const v = await mk("s11", ["a"]);
    const r = await changeStage({ verticalId: v.id, to: "pilot", changedBy: staff, override: { reason: "not needed here at all" } });
    expect(r.overridden).toBe(false);
    expect((await listStageChanges(v.id))[0]!.overrideReason).toBeNull();
  });

  it("detects concurrent stage changes", async () => {
    const v = await mk("s12", ["a"]);
    const results = await Promise.allSettled([changeStage({ verticalId: v.id, to: "pilot", changedBy: staff }), changeStage({ verticalId: v.id, to: "pilot", changedBy: staff })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await prisma.domainEvent.count({ where: { type: "VerticalStageChanged", aggregateId: v.id } })).toBe(1);
  });
});

describe("public reads", () => {
  it("resolves the vertical for a category through ancestors, preferring the most advanced stage", async () => {
    expect(await getVerticalForCategory(cat("child"))).toBeNull();
    const cand = await mk("r1", ["root"]);
    expect((await getVerticalForCategory(cat("child")))?.id).toBe(cand.id);
    expect((await getVerticalForCategory(cat("root")))?.id).toBe(cand.id);
    const pilot = await mk("r2", ["child"]);
    await changeStage({ verticalId: pilot.id, to: "pilot", changedBy: staff });
    expect((await getVerticalForCategory(cat("child")))?.id).toBe(pilot.id); // pilot beats candidate, cache invalidated by changeStage
    expect((await getVerticalForCategory(cat("root")))?.id).toBe(cand.id);
    expect(await getVerticalForCategory("unknown-category")).toBeNull();
    expect((await listOpenVerticals()).some((v) => v.id === pilot.id)).toBe(false);
  });
  it("cache is invalidated on create/update", async () => {
    const v = await mk("r3", ["c"]);
    expect((await getVerticalForCategory(cat("c")))?.name).toBe("r3");
    await updateVertical(v.id, { name: "r3 renamed" });
    expect((await getVerticalForCategory(cat("c")))?.name).toBe("r3 renamed");
  });
});

describe("template", () => {
  it("lists root categories and seeds the playbook checklist without naming a vertical", async () => {
    const roots = await listCandidateRoots();
    expect(roots.find((r) => r.slug === cat("root"))).toMatchObject({ children: 1 });
    const v = await createVerticalFromTemplate({ slug: `v-${tag}-t1`, name: "Template vertical", categorySlugs: [cat("root")], languages: ["hi", "en"] });
    ids.push(v.id);
    expect(v.attributeSchemaSlug).toBe(cat("root"));
    const items = await listChecklist(v.id);
    expect(items.length).toBe(Object.values(PLAYBOOK_TEMPLATE).flat().length);
    expect(new Set(items.map((i) => i.section)).size).toBe(6);
    expect(items.every((i) => !i.done)).toBe(true);
  });
  it("creates nothing when validation fails", async () => {
    await expect(createVerticalFromTemplate({ slug: `v-${tag}-t2`, name: "Bad", categorySlugs: ["nope"] })).rejects.toMatchObject({ code: "validation" });
    expect(await getVerticalBySlug(`v-${tag}-t2`)).toBeNull();
  });
  it("rolls back the vertical when seeding fails", async () => {
    const orig = prisma.verticalChecklistItem.create;
    (prisma.verticalChecklistItem as { create: unknown }).create = async () => { throw new Error("db down"); };
    try {
      await expect(createVerticalFromTemplate({ slug: `v-${tag}-t3`, name: "Rollback", categorySlugs: [cat("a")] })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      (prisma.verticalChecklistItem as { create: unknown }).create = orig;
    }
    expect(await getVerticalBySlug(`v-${tag}-t3`)).toBeNull();
  });
});
