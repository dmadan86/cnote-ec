import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  listings: new Map<string, { id: string; sellerBusinessId: string; status: string; category: { slug: string } }>(),
  verdict: "allow" as "allow" | "review" | "block",
  modThrows: false,
  allow: true,
  failListing: false,
  slugs: [] as (string | undefined)[],
}));

vi.mock("@cnote/ai", async (orig) => ({
  ...(await orig<typeof import("@cnote/ai")>()),
  moderate: async (input: { categorySlug?: string }) => {
    if (state.modThrows) throw new Error("model down");
    state.slugs.push(input.categorySlug);
    return { verdict: state.verdict, flags: [], reason: null, decisionId: randomUUID(), confidence: 1, needsReview: false };
  },
}));
vi.mock("@cnote/catalogue", () => ({
  getListing: async (id: string) => {
    if (state.failListing) throw new Error("catalogue down");
    return state.listings.get(id) ?? null;
  },
  listSellerListings: async () => [],
}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async () => new Map(), getPersonVerification: async () => ({ phone: null, phoneVerified: false, emailVerified: true, erased: false, createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() }) }));
vi.mock("@cnote/enquiry", () => ({}));
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: async () => state.allow }));

import {
  QA_PAGE_SIZE, TOMBSTONE_PERSON_ID, answerQuestion, askQuestion, countUnansweredQuestions, getModerationItem, listModerationQueue, listMyQuestions, listPublicQuestions,
  listSellerQuestions, moderate, react, stripContact, worker,
} from "../src";
import { purgeRejectedUgc } from "../src/retention";
import { syncAnswered } from "../src/qa-state";

const sellerBiz = randomUUID();
const otherBiz = randomUUID();
const staffId = randomUUID();
const people = Array.from({ length: 6 }, () => randomUUID());
const listingIds: string[] = [];
const newListing = () => {
  const id = randomUUID();
  state.listings.set(id, { id, sellerBusinessId: sellerBiz, status: "published", category: { slug: "yarn" } });
  listingIds.push(id);
  return id;
};
const buyer = (i: number) => ({ personId: people[i]!, businessId: null });
const seller = { personId: people[5]!, businessId: sellerBiz };
const Q = "What is the minimum order quantity for the 40s cotton yarn?";
const A = "The minimum order is 100 kg and we dispatch within 3 days.";

beforeEach(() => {
  state.verdict = "allow";
  state.modThrows = false;
  state.allow = true;
  state.failListing = false;
  state.slugs.length = 0;
});
afterAll(async () => {
  const qs = (await prisma.productQuestion.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((q) => q.id);
  const as = (await prisma.productAnswer.findMany({ where: { listingId: { in: listingIds } }, select: { id: true } })).map((a) => a.id);
  await prisma.ugcReaction.deleteMany({ where: { subjectId: { in: [...qs, ...as] } } });
  await prisma.productAnswer.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.productQuestion.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${qs})`;
  await prisma.$disconnect();
});

const eventsFor = (id: string) => prisma.domainEvent.findMany({ where: { aggregateId: id }, orderBy: { id: "asc" } });

describe("stripContact", () => {
  it("removes phones, emails, ID numbers and messenger links, keeps the rest", () => {
    const r = stripContact("Call me on +91 98765 43210 or mail raj@example.com, wa.me/919876543210, PAN ABCDE1234F. Is it waterproof?");
    expect(r.stripped).toBe(true);
    expect(r.text).not.toMatch(/9876|@|wa\.me|ABCDE/);
    expect(r.text).toContain("Is it waterproof?");
    expect(r.text).toContain("[removed]");
  });
  it("catches spaced and dotted digit runs", () => {
    expect(stripContact("ring 98 76 54 32 10 now").text).not.toMatch(/\d{2} \d{2}/);
    expect(stripContact("my number 9876.543.210").stripped).toBe(true);
  });
  it("leaves ordinary questions alone and is idempotent", () => {
    const q = "Do you ship 500 pcs of 12 mm bolts to Pune within 7 days?";
    expect(stripContact(q)).toEqual({ text: q, stripped: false });
    const once = stripContact("email a@b.co please").text;
    expect(stripContact(once).text).toBe(once);
  });
  it("collapses adjacent removals", () => {
    expect(stripContact("9876543210 / a@b.com / x@y.com").text).toBe("[removed]");
  });
});

describe("asking", () => {
  it("stores the stripped text, auto-approves a clean one (private until answered) and emits an event", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(0), l, { body: `${Q} Reach me at 9876543210` });
    expect(q.status).toBe("approved");
    expect(q.piiStripped).toBe(true);
    expect(q.body).not.toMatch(/9876543210/);
    const row = await prisma.productQuestion.findUniqueOrThrow({ where: { id: q.id } });
    expect(row.body).not.toMatch(/9876/);
    expect(state.slugs).toContain("yarn"); // category reaches the prohibited-category check
    const ev = (await eventsFor(q.id)).find((e) => e.type === "ProductQuestionAsked");
    expect(ev?.version).toBe(1);
    expect(ev?.payload).toMatchObject({ questionId: q.id, listingId: l, sellerBusinessId: sellerBiz, askerPersonId: people[0], status: "approved", piiStripped: true });
    expect((await listPublicQuestions(l)).items).toHaveLength(0);
  });

  it("flags review/block verdicts for staff and shows the asker 'pending' (never the AI screen)", async () => {
    const l = newListing();
    state.verdict = "block";
    const q = await askQuestion(buyer(0), l, { body: "Can I buy this to resell on another website?" });
    expect(q.status).toBe("pending");
    expect((await prisma.productQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("flagged");
    expect(await listSellerQuestions(sellerBiz, { listingId: l })).toMatchObject({ items: [] }); // sellers don't see held questions
  });

  it("keeps a question pending (staff-gated) when the model is down", async () => {
    const l = newListing();
    state.modThrows = true;
    const q = await askQuestion(buyer(0), l, { body: "Does it come with a test certificate?" });
    expect((await prisma.productQuestion.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("pending");
  });

  it("validates, blocks own product / unpublished listings, duplicates, too many open, and contact-only text", async () => {
    const l = newListing();
    await expect(askQuestion(buyer(0), l, { body: "too short" })).rejects.toThrow();
    await expect(askQuestion(buyer(0), l, { body: "x".repeat(501) })).rejects.toThrow();
    await expect(askQuestion(seller, l, { body: Q })).rejects.toMatchObject({ code: "forbidden" });
    await expect(askQuestion(buyer(0), randomUUID(), { body: Q })).rejects.toMatchObject({ code: "not_found" });
    state.listings.set("draft", { id: "draft", sellerBusinessId: sellerBiz, status: "draft", category: { slug: "yarn" } });
    await expect(askQuestion(buyer(0), "draft", { body: Q })).rejects.toMatchObject({ code: "not_found" });
    await expect(askQuestion(buyer(0), l, { body: "9876543210 9876543210 9876543210" })).rejects.toMatchObject({ code: "validation", key: "qa.onlyContact" });

    await askQuestion(buyer(1), l, { body: Q });
    await expect(askQuestion(buyer(1), l, { body: Q })).rejects.toMatchObject({ code: "conflict", key: "qa.duplicate" });
    await askQuestion(buyer(1), l, { body: "What is the lead time for 1 tonne?" });
    await askQuestion(buyer(1), l, { body: "Do you offer a GST invoice for this?" });
    await expect(askQuestion(buyer(1), l, { body: "Is a sample available before bulk orders?" })).rejects.toMatchObject({ code: "conflict", key: "qa.tooManyOpen" });
  });

  it("is rate limited per person", async () => {
    const l = newListing();
    state.allow = false;
    await expect(askQuestion(buyer(2), l, { body: Q })).rejects.toMatchObject({ code: "rate_limited" });
    expect(await prisma.productQuestion.count({ where: { listingId: l } })).toBe(0);
  });
});

describe("answering and visibility", () => {
  it("pending questions are visible only to the asker; an approved answer makes the Q&A public", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(0), l, { body: Q });
    expect((await listPublicQuestions(l)).total).toBe(0);
    expect((await listMyQuestions(l, people[0]!))[0]).toMatchObject({ id: q.id, status: "approved", answer: null });
    expect(await listMyQuestions(l, people[1]!)).toHaveLength(0);

    const a = await answerQuestion(seller, q.id, { body: `${A} Call 9876543210` });
    expect(a).toMatchObject({ status: "approved", piiStripped: true });
    const pub = await listPublicQuestions(l);
    expect(pub.total).toBe(1);
    expect(pub.items[0]).toMatchObject({ id: q.id, authorName: "Buyer", answer: { sellerName: "Seller", helpfulCount: 0 } });
    expect(pub.items[0]!.answer.body).not.toMatch(/9876/);
    expect((await listMyQuestions(l, people[0]!))[0]!.answer?.body).toContain("minimum order");
    const ev = (await eventsFor(q.id)).find((e) => e.type === "ProductQuestionAnswered");
    expect(ev?.payload).toMatchObject({ questionId: q.id, answerId: a.id, askerPersonId: people[0], answeredByPersonId: people[5], status: "approved" });
  });

  it("only the listing's seller answers, and only questions that cleared moderation", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(0), l, { body: Q });
    await expect(answerQuestion(buyer(1), q.id, { body: A })).rejects.toMatchObject({ code: "forbidden" });
    await expect(answerQuestion({ personId: people[4]!, businessId: otherBiz }, q.id, { body: A })).rejects.toMatchObject({ code: "forbidden" });
    await expect(answerQuestion(seller, q.id, { body: "x" })).rejects.toThrow();
    await expect(answerQuestion(seller, randomUUID(), { body: A })).rejects.toMatchObject({ code: "not_found" });
    state.verdict = "review";
    const held = await askQuestion(buyer(2), l, { body: "Is this product made with banned dyes?" });
    state.verdict = "allow";
    await expect(answerQuestion(seller, held.id, { body: A })).rejects.toMatchObject({ code: "not_found" });
    state.allow = false;
    await expect(answerQuestion(seller, q.id, { body: A })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("a flagged answer waits for staff and stays out of the public list; editing an approved answer re-moderates it", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(0), l, { body: Q });
    state.verdict = "review";
    const a = await answerQuestion(seller, q.id, { body: A });
    expect(a.status).toBe("pending");
    expect((await listPublicQuestions(l)).total).toBe(0);
    expect((await listSellerQuestions(sellerBiz, { listingId: l })).items[0]).toMatchObject({ needsAnswer: false, answer: { status: "flagged" } });

    const queue = await listModerationQueue({ kind: "answer", status: "flagged" });
    const item = queue.items.find((i) => i.id === a.id)!;
    expect(item).toMatchObject({ kind: "answer", context: Q, isSeller: true, parentId: q.id });
    const res = await moderate("answer", a.id, "approved", null, staffId);
    expect(res.after.status).toBe("approved");
    expect((await listPublicQuestions(l)).total).toBe(1);
    const mod = (await eventsFor(q.id)).find((e) => e.type === "ProductQaModerated");
    expect(mod?.payload).toMatchObject({ kind: "answer", id: a.id, status: "approved", askerPersonId: people[0], moderatedBy: staffId });

    state.verdict = "block";
    await answerQuestion(seller, q.id, { body: `${A} Updated.` });
    expect((await listPublicQuestions(l)).total).toBe(0); // edit pulled it from the public list
    expect((await prisma.productAnswer.count({ where: { questionId: q.id } }))).toBe(1); // still one answer per question
  });
});

describe("listing, search and the seller inbox", () => {
  it("paginates answered questions, newest answer first, and searches question and answer text", async () => {
    const l = newListing();
    for (let i = 0; i < QA_PAGE_SIZE + 2; i++) {
      const q = await askQuestion(buyer(i % 5), l, { body: `Question number ${i} about packaging options?` });
      await answerQuestion(seller, q.id, { body: i === 3 ? "Packed in HDPE bags of 25 kg." : `Answer ${i} here.` });
    }
    const p1 = await listPublicQuestions(l);
    expect(p1.items).toHaveLength(QA_PAGE_SIZE);
    expect(p1.total).toBe(QA_PAGE_SIZE + 2);
    expect(p1.nextCursor).toBe(String(QA_PAGE_SIZE));
    const p2 = await listPublicQuestions(l, { cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(QA_PAGE_SIZE + 2);

    expect((await listPublicQuestions(l, { q: "hdpe" })).items.map((i) => i.answer.body)).toEqual(["Packed in HDPE bags of 25 kg."]);
    expect((await listPublicQuestions(l, { q: "number 5" })).total).toBe(1);
    expect((await listPublicQuestions(l, { q: "%" })).total).toBe(QA_PAGE_SIZE + 2); // wildcards are neutralised, not matched literally
  });

  it("lists unanswered first and counts what needs an answer", async () => {
    const l = newListing();
    const answered = await askQuestion(buyer(0), l, { body: "First question about the product finish?" });
    const waiting = await askQuestion(buyer(1), l, { body: "Second question about the product finish?" });
    await answerQuestion(seller, answered.id, { body: A });
    const inbox = await listSellerQuestions(sellerBiz, { listingId: l });
    expect(inbox.items.map((i) => i.id)).toEqual([waiting.id, answered.id]);
    expect(inbox.items.map((i) => i.needsAnswer)).toEqual([true, false]);
    expect((await listSellerQuestions(sellerBiz, { listingId: l, needsAnswer: true })).items.map((i) => i.id)).toEqual([waiting.id]);
    const small = await listSellerQuestions(sellerBiz, { listingId: l, limit: 1 });
    expect(small.items[0]!.id).toBe(waiting.id);
    const next = await listSellerQuestions(sellerBiz, { listingId: l, limit: 1, cursor: small.nextCursor });
    expect(next.items[0]!.id).toBe(answered.id);
    expect(await countUnansweredQuestions(sellerBiz)).toBeGreaterThanOrEqual(1);
    expect(await countUnansweredQuestions(randomUUID())).toBe(0);
  });
});

describe("helpful votes and reports", () => {
  it("counts helpful once per person on answers, not on own content, and reports hide at the threshold", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(0), l, { body: Q });
    const a = await answerQuestion(seller, q.id, { body: A });
    expect(await react(buyer(1), { subjectType: "answer", subjectId: a.id, kind: "helpful" })).toEqual({ changed: true });
    expect(await react(buyer(1), { subjectType: "answer", subjectId: a.id, kind: "helpful" })).toEqual({ changed: false });
    await react(buyer(2), { subjectType: "answer", subjectId: a.id, kind: "helpful" });
    expect((await listPublicQuestions(l)).items[0]!.answer.helpfulCount).toBe(2); // cache purged on vote
    await expect(react(seller, { subjectType: "answer", subjectId: a.id, kind: "helpful" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(react(buyer(1), { subjectType: "question", subjectId: q.id, kind: "helpful" })).rejects.toMatchObject({ code: "validation" });
    await expect(react(buyer(1), { subjectType: "answer", subjectId: a.id, kind: "report" })).rejects.toThrow(); // reason required

    for (const i of [1, 2, 3]) await react(buyer(i), { subjectType: "answer", subjectId: a.id, kind: "report", reason: "misleading claim" });
    expect((await prisma.productAnswer.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("flagged");
    expect((await listPublicQuestions(l)).total).toBe(0);
    expect((await listModerationQueue({ kind: "answer", status: "flagged" })).items.some((i) => i.id === a.id && i.reportCount >= 3)).toBe(true);
  });

  it("only public (answered) questions can be reported", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(0), l, { body: Q });
    await expect(react(buyer(1), { subjectType: "question", subjectId: q.id, kind: "report", reason: "spam spam" })).rejects.toMatchObject({ code: "not_found" });
    await answerQuestion(seller, q.id, { body: A });
    for (const i of [1, 2, 3]) await react(buyer(i), { subjectType: "question", subjectId: q.id, kind: "report", reason: "spam spam" });
    expect((await prisma.productQuestion.findUniqueOrThrow({ where: { id: q.id } })).answeredAt).toBeNull(); // flagged question leaves the public list
    expect((await listPublicQuestions(l)).total).toBe(0);
  });
});

describe("moderation of questions", () => {
  it("staff approve a flagged question, which becomes answerable; reject needs a note and hides a public Q&A", async () => {
    const l = newListing();
    state.verdict = "block";
    const q = await askQuestion(buyer(0), l, { body: "Is this product suitable for restricted use?" });
    state.verdict = "allow";
    expect((await listModerationQueue({ kind: "question" })).items.some((i) => i.id === q.id)).toBe(true);
    expect(await getModerationItem("question", q.id)).toMatchObject({ kind: "question", status: "flagged" });
    expect(await getModerationItem("question", randomUUID())).toBeNull();
    await expect(moderate("question", q.id, "rejected", null, staffId)).rejects.toMatchObject({ code: "validation" });
    await moderate("question", q.id, "approved", null, staffId);
    expect((await moderate("question", q.id, "approved", null, staffId)).after.status).toBe("approved"); // idempotent
    await answerQuestion(seller, q.id, { body: A });
    expect((await listPublicQuestions(l)).total).toBe(1);

    const rej = await moderate("question", q.id, "rejected", "Not about this product", staffId);
    expect(rej.before.status).toBe("approved");
    expect((await listPublicQuestions(l)).total).toBe(0);
    expect((await listMyQuestions(l, people[0]!))[0]).toMatchObject({ status: "rejected", moderationNote: "Not about this product", answer: null });
    // re-approval restores it
    await moderate("question", q.id, "approved", null, staffId);
    expect((await listPublicQuestions(l)).total).toBe(1);
    await expect(moderate("question", randomUUID(), "approved", null, staffId)).rejects.toMatchObject({ code: "not_found" });
    await expect(moderate("answer", randomUUID(), "approved", null, staffId)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("erasure and retention", () => {
  it("anonymises public Q&A, deletes the person's never-public questions", async () => {
    const l = newListing();
    const person = randomUUID();
    const pub = await askQuestion({ personId: person, businessId: null }, l, { body: Q });
    await answerQuestion(seller, pub.id, { body: A });
    const open = await askQuestion({ personId: person, businessId: null }, l, { body: "Another one about warranty terms?" });
    await worker.handlers!.DataErasureRequested!({ payload: { personId: person } } as never);
    expect(await prisma.productQuestion.findUnique({ where: { id: open.id } })).toBeNull();
    const kept = await prisma.productQuestion.findUniqueOrThrow({ where: { id: pub.id } });
    expect(kept.authorPersonId).toBe(TOMBSTONE_PERSON_ID);
    expect((await listPublicQuestions(l)).items[0]!.authorName).toBe("Former user");
  });

  it("purges old rejected questions and answers", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(3), l, { body: "A question that staff will reject later?" });
    await moderate("question", q.id, "rejected", "Off topic", staffId);
    await prisma.productQuestion.update({ where: { id: q.id }, data: { moderatedAt: new Date(Date.now() - 400 * 864e5) } });
    const cutoff = new Date(Date.now() - 365 * 864e5);
    expect(await purgeRejectedUgc(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await purgeRejectedUgc(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await prisma.productQuestion.findUnique({ where: { id: q.id } })).toBeNull();
  });
});

describe("robustness", () => {
  it("still answers (without a category hint) when the catalogue lookup fails, and syncAnswered ignores unknown questions", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(4), l, { body: Q });
    state.failListing = true;
    state.slugs.length = 0;
    expect((await answerQuestion(seller, q.id, { body: A })).status).toBe("approved");
    expect(state.slugs).toEqual([undefined]);
    await prisma.$transaction((tx) => syncAnswered(tx, randomUUID()));
  });

  it("purges old rejected answers (the question stays; its answer is gone)", async () => {
    const l = newListing();
    const q = await askQuestion(buyer(4), l, { body: "Does this come with a warranty card?" });
    const a = await answerQuestion(seller, q.id, { body: "Please contact us for details." });
    await moderate("answer", a.id, "rejected", "Not an answer", staffId);
    await prisma.productAnswer.update({ where: { id: a.id }, data: { moderatedAt: new Date(Date.now() - 400 * 864e5) } });
    expect(await purgeRejectedUgc(new Date(Date.now() - 365 * 864e5))).toBeGreaterThanOrEqual(1);
    expect(await prisma.productAnswer.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await prisma.productQuestion.findUnique({ where: { id: q.id } })).not.toBeNull();
    expect((await listSellerQuestions(sellerBiz, { listingId: l })).items[0]).toMatchObject({ needsAnswer: true, answer: null });
  });
});
