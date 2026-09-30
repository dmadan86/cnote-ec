import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { extractListing, getReview, listOpenReviews, moderate, purgeOldDecisionInputs, resolveReview, scoreIntent } from "../src";

const runId = crypto.randomUUID();
const subject = (type: "enquiry" | "listing") => ({ type, id: `test-${runId}-${type}` });
const reviewer = crypto.randomUUID();

afterAll(async () => {
  await prisma.reviewItem.deleteMany({ where: { subjectId: { startsWith: `test-${runId}` } } });
  await prisma.aiDecision.deleteMany({ where: { subjectId: { startsWith: `test-${runId}` } } });
});

describe("decision logging + review queue", () => {
  it("logs a redacted AiDecision and flags sparse intent for review", async () => {
    const r = await scoreIntent(
      { title: "pipes", requirement: "need pipes, call 9876543210", buyerVerificationTier: 0, buyerPhoneVerified: false, buyerPriorEnquiries: 0, buyerPriorResponded: 0 },
      subject("enquiry"),
    );
    expect(r.needsReview).toBe(true);
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId }, include: { reviews: true } });
    expect(row).toMatchObject({ capability: "intent", provider: "heuristic", promptVersion: "intent-heuristic-v1" });
    expect(JSON.stringify(row.inputRedacted)).not.toContain("9876543210");
    expect(row.reviews).toHaveLength(1);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("does not enqueue a review for a confident allow", async () => {
    const r = await moderate({ text: "Corrugated boxes 5 ply for packaging" }, subject("listing"));
    expect(r).toMatchObject({ verdict: "allow", needsReview: false });
    expect(await prisma.reviewItem.count({ where: { aiDecisionId: r.decisionId } })).toBe(0);
  });

  it("always enqueues a 'review' verdict, and lists/resolves it once", async () => {
    const r = await moderate({ text: "citric acid food grade" }, subject("listing"));
    expect(r).toMatchObject({ verdict: "review", needsReview: true });
    // Look the item up by this test's subject: the shared test DB may hold more open items than one queue page.
    const mine = await prisma.reviewItem.findFirstOrThrow({ where: { aiDecisionId: r.decisionId, status: "open" } });
    const open = (await listOpenReviews(200)).find((x) => x.id === mine.id) ?? (await getReview(mine.id));
    expect(open).toBeTruthy();
    expect(open!.output).toMatchObject({ verdict: "review" });
    const done = await resolveReview(open!.id, "approved", reviewer);
    expect(done.id).toBe(open!.id);
    await expect(resolveReview(open!.id, "rejected", reviewer)).rejects.toMatchObject({ code: "conflict" });
    await expect(resolveReview(crypto.randomUUID(), "approved", reviewer)).rejects.toMatchObject({ code: "not_found" });
  });

  it("extractListing logs the decision with category slugs only", async () => {
    const r = await extractListing(
      { text: "3 ply corrugated boxes Rs 5 per piece", language: "en", categories: [{ slug: "corrugated-boxes", name: "Corrugated Boxes", attributeSchema: { fields: [] } }] },
      subject("listing"),
    );
    expect(r.categorySlug).toBe("corrugated-boxes");
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: r.decisionId } });
    expect(row.inputRedacted).toMatchObject({ categories: ["corrugated-boxes"] });
  });

  it("purges old inputs but keeps the row", async () => {
    const old = await prisma.aiDecision.create({
      data: {
        capability: "moderate", provider: "heuristic", modelId: "x", promptVersion: "x", inputRedacted: { text: "secret" }, output: {},
        confidence: 0.9, subjectType: "listing", subjectId: `test-${runId}-old`, latencyMs: 1, createdAt: new Date(Date.now() - 200 * 86_400_000),
      },
    });
    expect(await purgeOldDecisionInputs()).toBeGreaterThanOrEqual(1);
    const row = await prisma.aiDecision.findUniqueOrThrow({ where: { id: old.id } });
    expect(row.inputRedacted).toEqual({ purged: true });
    expect(await purgeOldDecisionInputs()).toBe(0); // idempotent (barring other suites' rows)
  });
});
