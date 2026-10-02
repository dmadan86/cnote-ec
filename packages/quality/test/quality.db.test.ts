import { setDispatchInspectorForTests, type InspectDispatchOutput } from "@cnote/ai";
import { prisma } from "@cnote/db";
import { setMediaStore } from "@cnote/media";
import { getJobQueue } from "@cnote/core";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSE_TOPIC_FOR_TESTS, analyseCheck, categoryAccuracy, getSubmissionContext, isCategoryAllowed, labelResult, listChecksForOrder, listCategoryStatuses, listForLabelling,
  listSellerChecks, purgeOldQualityMedia, qualityMediaKey, readQualityMedia, requeueStuckChecks, setCategoryEnabled, setOrderContextPort, submitDispatchPhotos, worker, enabledCategories, getCheckView,
} from "./api";
import { MemStore, actor, fakePort, photo } from "./helpers";

const store = new MemStore();
const orders: string[] = [];
const newOrder = () => { const id = randomUUID(); orders.push(id); return id; };
const verdictOut = (over: Partial<InspectDispatchOutput> = {}, confidence = 0.9) => ({
  output: {
    checks: [
      { check: "quantity" as const, result: "consistent" as const, confidence: 0.9, note: "ok" },
      { check: "labelling" as const, result: "inconsistent" as const, confidence: 0.8, note: "no brand" },
      { check: "spec" as const, result: "consistent" as const, confidence: 0.7, note: "ok" },
    ],
    verdict: "inconsistent" as const, ...over,
  },
  confidence, provider: "test", modelId: "test-model", promptVersion: "test-v1",
});

const env = { ...process.env };
beforeAll(async () => {
  process.env.QUALITY_CHECKS_ENABLED = "true";
  process.env.QUALITY_CHECK_CATEGORIES = "test-cat";
  setMediaStore(store);
  await prisma.qualityCategory.deleteMany();
});
beforeEach(() => { setOrderContextPort(fakePort()); });
afterEach(() => { vi.restoreAllMocks(); setDispatchInspectorForTests(null); process.env.QUALITY_CHECKS_ENABLED = "true"; process.env.QUALITY_CHECK_CATEGORIES = "test-cat"; });
afterAll(async () => {
  setOrderContextPort(null); setMediaStore(undefined);
  process.env = env;
  const checks = (await prisma.qualityCheck.findMany({ where: { orderId: { in: orders } }, select: { id: true } })).map((c) => c.id);
  await prisma.qualityLabel.deleteMany({ where: { checkId: { in: checks } } });
  await prisma.qualityCheckResult.deleteMany({ where: { checkId: { in: checks } } });
  await prisma.qualityCheckMedia.deleteMany({ where: { checkId: { in: checks } } });
  await prisma.qualityCheck.deleteMany({ where: { id: { in: checks } } });
  await prisma.qualityCategory.deleteMany();
  await prisma.$executeRaw`DELETE FROM domain_events WHERE type = 'QualityCheckCompleted' AND aggregate_id::text = ANY(${orders})`;
});

afterEach(() => vi.useRealTimers());

describe("eligibility", () => {
  it("is hidden when the flag is off, and unknown orders are not found", async () => {
    process.env.QUALITY_CHECKS_ENABLED = "false";
    expect(await getSubmissionContext(actor(), newOrder())).toMatchObject({ eligible: false, reason: "disabled" });
    process.env.QUALITY_CHECKS_ENABLED = "true";
    setOrderContextPort({ load: async () => null });
    expect(await getSubmissionContext(actor(), newOrder())).toMatchObject({ reason: "not_found" });
  });
  it.each([
    [{ role: "buyer" as const }, "not_seller"],
    [{ categorySlug: null }, "no_category"],
    [{ categorySlug: "other-cat" }, "category_not_enabled"],
    [{ status: "delivered" }, "order_status"],
  ])("ineligible %j -> %s", async (over, reason) => {
    setOrderContextPort(fakePort(over));
    expect(await getSubmissionContext(actor(), newOrder())).toMatchObject({ eligible: false, reason });
  });
  it("eligible orders get a checklist derived from the order", async () => {
    const c = await getSubmissionContext(actor(), newOrder());
    expect(c).toMatchObject({ eligible: true, categorySlug: "test-cat", checksUsed: 0 });
    expect(c.checklist.map((i) => i.check)).toEqual(["quantity", "labelling", "spec"]);
    expect(c.checklist[0]!.expected).toBe("100 piece");
    expect(c.checklist[2]!.expected).toContain("ply: 3");
  });
});

describe("submitDispatchPhotos", () => {
  it("stores private stripped photos, creates a pending check, enqueues analysis", async () => {
    const enq = vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    const a = actor(); const orderId = newOrder();
    const v = await submitDispatchPhotos(a, orderId, [{ bytes: photo(0), filename: "a.png" }, { bytes: photo(0) }, { bytes: photo(1) }]);
    expect(v).toMatchObject({ status: "pending", orderId, categorySlug: "test-cat", advisory: true, verdict: null });
    expect(v.mediaIds).toHaveLength(2); // duplicate dropped by hash
    const media = await prisma.qualityCheckMedia.findMany({ where: { checkId: v.id } });
    for (const m of media) {
      expect(m.key).toBe(qualityMediaKey(v.id, m.id));
      expect(store.objs.get(m.key)!.contentType).toBe("image/jpeg");
      expect(store.objs.get(m.key)!.bytes[0]).toBe(0xff);
    }
    expect(enq).toHaveBeenCalledWith("quality.analyse", { checkId: v.id }, expect.objectContaining({ dedupeKey: `analyse:${v.id}` }));
    expect(await listSellerChecks(a.businessId, orderId)).toHaveLength(1);
    expect(await listSellerChecks(a.businessId, "nope")).toEqual([]);
    expect((await prisma.qualityCheck.findUniqueOrThrow({ where: { id: v.id } })).expectedSpec).toMatchObject({ quantity: 100 });
  });

  it("rejects bad input, ineligible orders and the per-order limit", async () => {
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    const a = actor(); const orderId = newOrder();
    await expect(submitDispatchPhotos(a, orderId, [])).rejects.toMatchObject({ code: "validation" });
    await expect(submitDispatchPhotos(a, orderId, Array(5).fill({ bytes: photo() }))).rejects.toMatchObject({ code: "validation" });
    await expect(submitDispatchPhotos(a, orderId, [{ bytes: new Uint8Array([1, 2, 3]), filename: "x.jpg" }])).rejects.toThrow(/x\.jpg/);
    setOrderContextPort(fakePort({ role: "buyer" }));
    await expect(submitDispatchPhotos(a, orderId, [{ bytes: photo() }])).rejects.toMatchObject({ code: "forbidden" });
    setOrderContextPort({ load: async () => null });
    await expect(submitDispatchPhotos(a, orderId, [{ bytes: photo() }])).rejects.toMatchObject({ code: "not_found" });
    setOrderContextPort(fakePort({ status: "completed" }));
    await expect(submitDispatchPhotos(a, orderId, [{ bytes: photo() }])).rejects.toMatchObject({ code: "conflict" });
    setOrderContextPort(fakePort());
    for (let i = 0; i < 3; i++) await submitDispatchPhotos(a, orderId, [{ bytes: photo(i) }]);
    await expect(submitDispatchPhotos(a, orderId, [{ bytes: photo(9) }])).rejects.toThrow(/at most 3/);
  });

  it("cleans up stored objects when persistence fails", async () => {
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("db down"));
    const before = store.objs.size;
    await expect(submitDispatchPhotos(actor(), newOrder(), [{ bytes: photo(3) }])).rejects.toThrow("db down");
    expect(store.objs.size).toBe(before);
  });

  it("rate limits submissions per person", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // fixed-window limiter: a real minute/hour boundary mid-test would reset the counter
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    const a = actor();
    let limited = false;
    for (let i = 0; i < 11 && !limited; i++) {
      try { await submitDispatchPhotos(a, newOrder(), [{ bytes: photo(i) }]); } catch (e: any) { limited = e.code === "rate_limited"; }
    }
    expect(limited).toBe(true);
  });
});

describe("analyseCheck", () => {
  async function pending() {
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    const a = actor(); const orderId = newOrder();
    const v = await submitDispatchPhotos(a, orderId, [{ bytes: photo(5) }]);
    return { a, orderId, id: v.id };
  }

  it("completes, persists per-check results, emits QualityCheckCompleted once, and is idempotent", async () => {
    const { a, orderId, id } = await pending();
    const inspect = vi.fn(async () => verdictOut());
    setDispatchInspectorForTests({ inspect });
    expect(await analyseCheck(id)).toBe("completed");
    expect(await analyseCheck(id)).toBe("skipped");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect((inspect.mock.calls[0] as any)[0].images[0].bytes.length).toBeGreaterThan(100);
    const v = (await getCheckView(id))!;
    expect(v).toMatchObject({ status: "completed", verdict: "inconsistent", needsReview: true });
    expect(v.results.map((r) => r.check)).toEqual(["quantity", "labelling", "spec"]);
    const ev = await prisma.$queryRaw<{ payload: any }[]>`SELECT payload FROM domain_events WHERE type = 'QualityCheckCompleted' AND aggregate_id::text = ${orderId}`;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ checkId: id, orderId, sellerBusinessId: a.businessId, categorySlug: "test-cat", verdict: "inconsistent" });
    const row = await prisma.qualityCheck.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ promptVersion: "test-v1", modelId: "test-model", completedAt: expect.any(Date) });
    expect(row.decisionId).toBeTruthy();
    // AiDecision holds no image bytes
    const dec = await prisma.aiDecision.findUniqueOrThrow({ where: { id: row.decisionId! } });
    expect(dec.capability).toBe("inspect_dispatch");
    expect(JSON.stringify(dec.inputRedacted)).not.toContain("9876543210");
  });

  it("uses the offline heuristic by default: inconclusive, needs review", async () => {
    const { id } = await pending();
    expect(await analyseCheck(id)).toBe("completed");
    expect(await getCheckView(id)).toMatchObject({ verdict: "inconclusive", needsReview: true });
  });

  it("fails permanently when photos are missing, and on the last attempt; retries earlier", async () => {
    const { id } = await pending();
    store.objs.clear();
    expect(await analyseCheck(id)).toBe("failed");
    expect(await getCheckView(id)).toMatchObject({ status: "failed" });

    const p2 = await pending();
    await prisma.qualityCheckMedia.updateMany({ where: { checkId: p2.id }, data: { purgedAt: new Date() } });
    expect(await analyseCheck(p2.id)).toBe("failed");

    const p3 = await pending();
    setDispatchInspectorForTests({ inspect: async () => { throw new Error("vendor down"); } });
    await expect(analyseCheck(p3.id, { attempt: 1, maxAttempts: 3 })).rejects.toThrow("vendor down");
    expect((await prisma.qualityCheck.findUniqueOrThrow({ where: { id: p3.id } })).status).toBe("pending");
    expect(await analyseCheck(p3.id, { attempt: 3, maxAttempts: 3 })).toBe("failed");
    expect((await prisma.qualityCheck.findUniqueOrThrow({ where: { id: p3.id } })).failureReason).toContain("vendor down");
  });

  it("requeues checks stuck in analysing", async () => {
    const { id } = await pending();
    const enq = vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    await prisma.qualityCheck.update({ where: { id }, data: { status: "analysing" } });
    expect(await requeueStuckChecks()).toBe(0);
    expect(await requeueStuckChecks(new Date(Date.now() + 3_600_000))).toBeGreaterThanOrEqual(1);
    expect((await prisma.qualityCheck.findUniqueOrThrow({ where: { id } })).status).toBe("pending");
    expect(enq).toHaveBeenCalled();
  });

  it("worker consumes the topic and exposes its jobs", async () => {
    const { id } = await pending();
    const q = worker.queues![0]!;
    expect(q.topic).toBe(ANALYSE_TOPIC_FOR_TESTS);
    await q.handler({ id: "1", topic: q.topic, payload: { checkId: id }, attempt: 1, maxAttempts: 3, enqueuedAt: "" } as never);
    expect((await getCheckView(id))!.status).toBe("completed");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const j of worker.jobs) await j.run();
    log.mockRestore();
    expect(worker.jobs.map((j) => j.name)).toEqual(["quality.requeue-stuck", "quality.purge-media"]);
  });
});

describe("advisory evidence for disputes", () => {
  it("lists completed checks only, with the advisory disclaimer and no media handles", async () => {
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    const a = actor(); const orderId = newOrder();
    const done = await submitDispatchPhotos(a, orderId, [{ bytes: photo(6) }]);
    await submitDispatchPhotos(a, orderId, [{ bytes: photo(7) }]);
    setDispatchInspectorForTests({ inspect: async () => verdictOut({ verdict: "consistent" }) });
    await analyseCheck(done.id);
    const ev = await listChecksForOrder(orderId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ checkId: done.id, advisory: true, photoCount: 1, verdict: "consistent" });
    expect(ev[0]!.disclaimer).toMatch(/not a pass\/fail/);
    expect(JSON.stringify(ev)).not.toContain("quality/");
    expect(await listChecksForOrder("bad")).toEqual([]);
    expect(await listChecksForOrder(randomUUID())).toEqual([]);
  });
});

describe("media access and retention", () => {
  it("only the owning seller or staff can read photos", async () => {
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    const a = actor();
    const v = await submitDispatchPhotos(a, newOrder(), [{ bytes: photo(8) }]);
    const id = v.mediaIds[0]!;
    expect((await readQualityMedia(id, { sellerBusinessId: a.businessId }))?.contentType).toBe("image/jpeg");
    expect(await readQualityMedia(id, { sellerBusinessId: randomUUID() })).toBeNull();
    expect(await readQualityMedia(id, { staff: true })).not.toBeNull();
    expect(await readQualityMedia("bad", { staff: true })).toBeNull();
    expect(await readQualityMedia(randomUUID(), { staff: true })).toBeNull();
    store.objs.delete(qualityMediaKey(v.id, id));
    expect(await readQualityMedia(id, { staff: true })).toBeNull();
  });

  it("purgeOldQualityMedia deletes objects, marks rows, is idempotent and supports dry run", async () => {
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    const v = await submitDispatchPhotos(actor(), newOrder(), [{ bytes: photo(10) }, { bytes: photo(11) }]);
    const keys = (await prisma.qualityCheckMedia.findMany({ where: { checkId: v.id } })).map((m) => m.key);
    const future = new Date(Date.now() + 60_000);
    expect(await purgeOldQualityMedia(new Date(0))).toBe(0);
    expect(await purgeOldQualityMedia(future, { dryRun: true })).toBeGreaterThanOrEqual(2);
    expect(keys.every((k) => store.objs.has(k))).toBe(true);
    expect(await purgeOldQualityMedia(future)).toBeGreaterThanOrEqual(2);
    expect(keys.some((k) => store.objs.has(k))).toBe(false);
    expect((await getCheckView(v.id))!.mediaIds).toEqual([]);
    expect(await purgeOldQualityMedia(future)).toBe(0);
  });
});

describe("accuracy gate", () => {
  async function labelled(slug: string, n: number, correctN: number) {
    vi.spyOn(getJobQueue(), "enqueue").mockResolvedValue("1");
    setOrderContextPort(fakePort({ categorySlug: slug }));
    const v = await submitDispatchPhotos(actor(), newOrder(), [{ bytes: photo(20 + n) }]);
    setDispatchInspectorForTests({ inspect: async () => verdictOut({ verdict: "consistent" }) });
    await analyseCheck(v.id);
    const items = await listForLabelling({ categorySlug: slug });
    expect(items.length).toBe(3);
    // three results per check: quantity consistent, labelling inconsistent, spec consistent
    for (const it of items) await labelResult(randomUUID(), it.resultId, it.result);
    void n; void correctN;
    return items;
  }

  it("labelling validates input, replaces labels and feeds accuracy", async () => {
    const slug = `acc-${randomUUID().slice(0, 8)}`;
    process.env.QUALITY_CHECK_CATEGORIES = `test-cat,${slug}`;
    const items = await labelled(slug, 1, 3);
    const unl = await listForLabelling({ categorySlug: slug });
    expect(unl).toHaveLength(0);
    const all = await listForLabelling({ categorySlug: slug, unlabelledOnly: false });
    expect(all.every((i) => i.label === i.result)).toBe(true);
    expect(all[0]!.expected.quantity).toBe(100);
    expect(await categoryAccuracy(slug)).toMatchObject({ labelled: 3, correct: 3, accuracy: 1, meetsGate: false });
    await labelResult(randomUUID(), items[0]!.resultId, items[0]!.result === "consistent" ? "inconsistent" : "consistent");
    expect(await categoryAccuracy(slug)).toMatchObject({ labelled: 3, correct: 2 });
    await expect(labelResult(randomUUID(), items[0]!.resultId, "pass")).rejects.toMatchObject({ code: "validation" });
    await expect(labelResult(randomUUID(), "bad", "consistent")).rejects.toMatchObject({ code: "not_found" });
    await expect(labelResult(randomUUID(), randomUUID(), "consistent")).rejects.toMatchObject({ code: "not_found" });
    expect(await categoryAccuracy("no-labels-here")).toMatchObject({ labelled: 0, accuracy: null, meetsGate: false });
  });

  it("enabling: first category is the pilot, later ones need >= minLabels and > minAccuracy", async () => {
    await prisma.qualityCategory.deleteMany();
    const staff = randomUUID();
    process.env.QUALITY_CHECK_CATEGORIES = "";
    const pilot = await setCategoryEnabled("pilot-cat", true, staff);
    expect(pilot).toMatchObject({ enabled: true, pilot: true });
    expect(await isCategoryAllowed("pilot-cat")).toBe(true);
    expect(await enabledCategories()).toContain("pilot-cat");

    // second category: no evidence
    await expect(setCategoryEnabled("second-cat", true, staff)).rejects.toMatchObject({ code: "conflict" });
    await expect(setCategoryEnabled("Bad Slug!", true, staff)).rejects.toMatchObject({ code: "validation" });
    expect(await isCategoryAllowed("second-cat")).toBe(false);

    // seed labels directly: 10 labels, 10 correct, minLabels=10 -> passes; 9/10 fails (needs > 90%)
    process.env.QUALITY_MIN_LABELS = "10";
    const slug = "second-cat";
    const check = await prisma.qualityCheck.create({ data: { orderId: newOrder(), sellerBusinessId: randomUUID(), submittedByPersonId: randomUUID(), categorySlug: slug, status: "completed" } });
    const mk = async (i: number, correct: boolean) => {
      const r = await prisma.qualityCheckResult.create({ data: { checkId: check.id, check: `c${i}`, result: "consistent", confidence: 0.9 } });
      await prisma.qualityLabel.create({ data: { resultId: r.id, checkId: check.id, check: `c${i}`, categorySlug: slug, label: correct ? "consistent" : "inconsistent", labelledBy: staff } });
    };
    for (let i = 0; i < 9; i++) await mk(i, true);
    await mk(9, false);
    await expect(setCategoryEnabled(slug, true, staff)).rejects.toThrow(/at least 10 labels and accuracy above 90%/);
    await mk(10, true); await mk(11, true); await mk(12, true); await mk(13, true); await mk(14, true); await mk(15, true); await mk(16, true); await mk(17, true); await mk(18, true); await mk(19, true);
    // 19/20 = 95%
    const on = await setCategoryEnabled(slug, true, staff);
    expect(on).toMatchObject({ enabled: true, pilot: false, labelled: 20 });
    const row = await prisma.qualityCategory.findUniqueOrThrow({ where: { categorySlug: slug } });
    expect(row).toMatchObject({ labelsAtEnable: 20, updatedBy: staff });
    expect(row.accuracyAtEnable).toBeCloseTo(0.95);
    expect(await isCategoryAllowed(slug)).toBe(true);

    const off = await setCategoryEnabled(slug, false, staff);
    expect(off.enabled).toBe(false);
    expect(await isCategoryAllowed(slug)).toBe(false);
    expect((await listCategoryStatuses()).map((c) => c.categorySlug)).toEqual(expect.arrayContaining(["pilot-cat", "second-cat"]));
    delete process.env.QUALITY_MIN_LABELS;
    await prisma.qualityLabel.deleteMany({ where: { checkId: check.id } });
    await prisma.qualityCheckResult.deleteMany({ where: { checkId: check.id } });
    await prisma.qualityCheck.delete({ where: { id: check.id } });
  });

  it("threshold env overrides are honoured", async () => {
    process.env.QUALITY_MIN_ACCURACY = "0.5"; process.env.QUALITY_MIN_LABELS = "x";
    const s = await categoryAccuracy("whatever");
    expect(s).toMatchObject({ minAccuracy: 0.5, minLabels: 50 });
    delete process.env.QUALITY_MIN_ACCURACY; delete process.env.QUALITY_MIN_LABELS;
  });
});
