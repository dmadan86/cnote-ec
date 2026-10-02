import type { DomainEvent } from "@cnote/core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ defined: [] as unknown[] }));
vi.mock("@cnote/templates", () => ({ defineTemplates: (d: unknown) => { h.defined.push(d); }, isChannelEnabled: async () => true, renderText: async () => ({ title: "t", body: "b" }) }));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { PHASE23_KINDS } from "../src/kinds-phase23";
import { KINDS, getKind, kindsFor, observedEvents, registerNotificationTemplates, templateDefinitions } from "../src/kinds";
import { CATEGORY_META, channelLock, defaultPreference, effectiveChannels } from "../src/preferences";
import { redact, maskEmail, listQueueTopics, registerQueueTopic } from "../src/ops";
import { absoluteUrl } from "../src/pipeline";
import { getChannelAdapter, setChannelAdapter } from "../src/channels";
import { CATEGORIES, CHANNELS, NOTIFICATION_APPS, type NotificationChannel } from "../src/types";
import type { Directory } from "../src/recipients";
import { worker } from "../src/worker";

const SB = "sb", BB = "bb";
const dir = (over: Partial<Directory> = {}): Directory => ({
  businessMembers: async (b, o) => (b === SB ? (o?.ownersOnly ? ["s-owner"] : ["s1", "s2", "s1"]) : b === BB ? ["b1"] : []),
  businessName: async () => "Sharma",
  enquiry: async () => ({ title: "Yarn", intentScore: 80, buyerBusinessId: BB, buyerPersonId: "b1" }),
  conversation: async () => ({ enquiryId: "e", enquiryTitle: "Yarn", buyerBusinessId: BB, buyerName: "Acme", sellerBusinessId: SB, sellerName: "Sharma" }),
  listingTitle: async () => "Cotton",
  review: async () => ({ authorPersonId: "author", moderationNote: "ok" }),
  comment: async () => ({ authorPersonId: "cauthor", moderationNote: null }),
  contact: async () => null,
  ...over,
});
const ev = (type: string, payload: unknown): DomainEvent => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: "x", payload, occurredAt: "" }) as never;

interface Row { key: string; event: ReturnType<typeof ev>; people: string[]; app?: string; vars?: Record<string, unknown>; href?: string }
const TABLE: Row[] = [
  { key: "lead.matched", event: ev("LeadMatched", { enquiryId: "e", matchId: "m", sellerBusinessId: SB }), people: ["s1", "s2"], vars: { enquiryTitle: "Yarn", intentScore: 80 }, href: "/leads" },
  { key: "lead.accepted", event: ev("LeadAccepted", { enquiryId: "e", sellerBusinessId: SB }), people: ["b1"], vars: { sellerName: "Sharma" }, href: "/buyer/enquiries/e" },
  { key: "message.received", event: ev("MessageSent", { conversationId: "c", senderPersonId: "s1" }), people: ["b1"], app: "web", vars: { senderName: "Sharma" } },
  { key: "message.received", event: ev("MessageSent", { conversationId: "c", senderPersonId: "b1" }), people: ["s1", "s2"], app: "seller", vars: { senderName: "Acme" } },
  { key: "quote.received", event: ev("QuoteSent", { conversationId: "c", pricePaise: 12000, quantity: 5 }), people: ["b1"], vars: { price: "₹120", quantity: 5 } },
  { key: "enquiry.under_review", event: ev("EnquiryScored", { enquiryId: "e", needsReview: true }), people: ["b1"], href: "/buyer/enquiries/e" },
  { key: "listing.rejected", event: ev("ListingModerated", { listingId: "l", sellerBusinessId: SB, status: "rejected", reason: "blurry" }), people: ["s1", "s2"], vars: { reason: "blurry", listingTitle: "Cotton" }, href: "/listings/l/edit" },
  { key: "listing.rejected", event: ev("ListingModerated", { listingId: "l", sellerBusinessId: SB, status: "rejected" }), people: ["s1", "s2"], vars: { reason: "See the listing for details" } },
  { key: "listing.image_rejected", event: ev("ListingImageModerated", { listingId: "l", sellerBusinessId: SB, status: "rejected" }), people: ["s1", "s2"], href: "/listings/l/edit" },
  { key: "review.moderated", event: ev("ReviewModerated", { reviewId: "r", listingId: "l", sellerBusinessId: SB, status: "approved", rating: 5 }), people: ["author"], vars: { outcome: "approved", note: "ok" } },
  { key: "review.moderated", event: ev("ReviewModerated", { reviewId: "r", listingId: "l", sellerBusinessId: SB, status: "rejected", rating: 1 }), people: ["author"], vars: { outcome: "not approved" } },
  { key: "review.received", event: ev("ReviewModerated", { reviewId: "r", listingId: "l", sellerBusinessId: SB, status: "approved", rating: 4 }), people: ["s1", "s2"], vars: { rating: 4 }, href: "/reviews" },
  { key: "comment.moderated", event: ev("CommentModerated", { commentId: "c", listingId: "l", status: "approved" }), people: ["cauthor"], vars: { outcome: "approved", note: "" } },
  { key: "qa.question_asked", event: ev("ProductQuestionAsked", { questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "approved" }), people: ["s1", "s2"], vars: { listingTitle: "Cotton" }, href: "/questions" },
  { key: "qa.question_released", event: ev("ProductQaModerated", { kind: "question", id: "q", questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "approved" }), people: ["s1", "s2"], vars: { listingTitle: "Cotton" }, href: "/questions" },
  { key: "qa.answered", event: ev("ProductQuestionAnswered", { questionId: "q", answerId: "a", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "approved" }), people: ["b1"], vars: { listingTitle: "Cotton" }, href: "/products/l#questions" },
  { key: "qa.answer_released", event: ev("ProductQaModerated", { kind: "answer", id: "a", questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "approved" }), people: ["b1"], vars: { listingTitle: "Cotton" }, href: "/products/l#questions" },
  { key: "billing.credits_granted", event: ev("CreditsGranted", { businessId: SB, amount: 10, reason: "plan_free" }), people: ["s-owner"], vars: { amount: 10, reason: "plan free" }, href: "/billing" },
  { key: "billing.subscription_started", event: ev("SubscriptionStarted", { businessId: SB, planCode: "pro" }), people: ["s-owner"], vars: { planCode: "pro" } },
  { key: "billing.subscription_cancelled", event: ev("SubscriptionCancelled", { businessId: SB, planCode: "pro" }), people: ["s-owner"], vars: { planCode: "pro" } },
  { key: "business.verified", event: ev("BusinessVerified", { businessId: SB, tier: "gst" }), people: ["s-owner"], vars: { tier: "gst" }, href: "/verification" },
  { key: "trust.badge_revoked", event: ev("TrustScoreChanged", { businessId: SB, from: 50, to: 30, badgeActive: false }), people: ["s-owner"], vars: { score: 30 } },
  { key: "lead.reachability_result", event: ev("ReachabilityChecked", { checkId: "c", enquiryId: "e", matchId: "m", channel: "sms", status: "responded", sellerBusinessId: SB }), people: ["s1", "s2"], href: "/leads" },
];
const NONE: { key: string; event: ReturnType<typeof ev>; note: string }[] = [
  { key: "enquiry.under_review", event: ev("EnquiryScored", { enquiryId: "e", needsReview: false }), note: "no review needed" },
  { key: "listing.rejected", event: ev("ListingModerated", { listingId: "l", sellerBusinessId: SB, status: "approved" }), note: "approved" },
  { key: "listing.image_rejected", event: ev("ListingImageModerated", { listingId: "l", sellerBusinessId: SB, status: "approved" }), note: "approved" },
  { key: "review.received", event: ev("ReviewModerated", { reviewId: "r", listingId: "l", sellerBusinessId: SB, status: "rejected", rating: 2 }), note: "rejected reviews are private" },
  { key: "qa.question_asked", event: ev("ProductQuestionAsked", { questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "flagged" }), note: "held for staff: the seller is told on approval" },
  { key: "qa.question_released", event: ev("ProductQaModerated", { kind: "answer", id: "a", questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "approved" }), note: "an answer is not a question" },
  { key: "qa.question_released", event: ev("ProductQaModerated", { kind: "question", id: "q", questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "rejected" }), note: "rejected" },
  { key: "qa.answered", event: ev("ProductQuestionAnswered", { questionId: "q", answerId: "a", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "pending" }), note: "answer held for staff" },
  { key: "qa.answer_released", event: ev("ProductQaModerated", { kind: "question", id: "q", questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "approved" }), note: "a question is not an answer" },
  { key: "qa.answer_released", event: ev("ProductQaModerated", { kind: "answer", id: "a", questionId: "q", listingId: "l", sellerBusinessId: SB, askerPersonId: "b1", status: "rejected" }), note: "rejected" },
  { key: "trust.badge_revoked", event: ev("TrustScoreChanged", { businessId: SB, from: 50, to: 45, badgeActive: false }), note: "still above threshold" },
  { key: "trust.badge_revoked", event: ev("TrustScoreChanged", { businessId: SB, from: 30, to: 20, badgeActive: false }), note: "was already below" },
  { key: "trust.badge_revoked", event: ev("TrustScoreChanged", { businessId: SB, from: 50, to: 30, badgeActive: true }), note: "badge still active" },
  { key: "lead.reachability_result", event: ev("ReachabilityChecked", { checkId: "c", enquiryId: "e", matchId: null, channel: "sms", status: "failed" }), note: "no match / seller" },
];

describe("kinds registry", () => {
  it("has unique keys, valid categories/apps, template variables cover placeholders", () => {
    expect(new Set(KINDS.map((k) => k.key)).size).toBe(KINDS.length);
    for (const k of KINDS) {
      expect(CATEGORIES).toContain(k.category);
      expect(NOTIFICATION_APPS).toContain(k.app);
      expect(getKind(k.key)).toBe(k);
      const names = new Set(k.variables.map((x) => x.name));
      for (const c of [k.defaults.in_app, k.defaults.email]) {
        if (!c) continue;
        for (const m of `${c.subject ?? ""} ${c.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) expect(names, `${k.key} uses {{${m[1]}}}`).toContain(m[1]);
      }
      expect(CATEGORY_META[k.category]).toBeDefined();
    }
  });
  it("every kind is exercised by the mapping table", () => {
    const covered = new Set(TABLE.map((r) => r.key));
    const phase23 = new Set(PHASE23_KINDS.map((k) => k.key)); // covered in kinds-phase23.test.ts
    for (const k of KINDS) if (!phase23.has(k.key)) expect(covered, k.key).toContain(k.key);
  });
  it("observedEvents/kindsFor are consistent; several kinds may share an event", () => {
    const evs = observedEvents();
    expect(new Set(evs).size).toBe(evs.length);
    for (const e of evs) expect(kindsFor(e).length).toBeGreaterThan(0);
    expect(kindsFor("ReviewModerated").map((k) => k.key).sort()).toEqual(["review.moderated", "review.received"]);
    expect(kindsFor("Nope" as never)).toEqual([]);
    expect(getKind("nope")).toBeUndefined();
  });
  it("template definitions map category (security/marketing/transactional) and register once", () => {
    const defs = templateDefinitions();
    expect(defs).toHaveLength(KINDS.length);
    expect(defs.every((d) => d.category === "transactional")).toBe(true);
    registerNotificationTemplates();
    registerNotificationTemplates();
    expect(h.defined.length).toBeLessThanOrEqual(1);
  });
  it("worker registers a handler for every observed event, prune job and deliver queue", () => {
    expect(Object.keys(worker.handlers ?? {}).sort()).toEqual([...observedEvents()].sort());
    expect(worker.jobs!.map((j) => j.name)).toEqual(["prune-read"]);
    expect(worker.queues!.map((q) => q.topic)).toEqual(["notification.deliver"]);
  });
});

describe("event → kind → recipients (table-driven)", () => {
  it.each(TABLE.map((r, i) => [`${r.key} #${i}`, r] as const))("%s", async (_n, row) => {
    const kind = getKind(row.key)!;
    const out = await kind.resolve(row.event as never, dir());
    expect(out.map((r) => r.personId).sort()).toEqual([...row.people].sort());
    expect(new Set(out.map((r) => r.personId)).size).toBe(out.length); // no duplicates
    for (const r of out) {
      if (row.app) expect(r.app).toBe(row.app);
      if (row.vars) expect(r.vars).toMatchObject(row.vars);
      if (row.href) expect(r.href).toBe(row.href);
      expect(r.href.startsWith("/")).toBe(true);
    }
  });
  it.each(NONE.map((r) => [`${r.key}: ${r.note}`, r] as const))("no recipients: %s", async (_n, row) => {
    expect(await getKind(row.key)!.resolve(row.event as never, dir())).toEqual([]);
  });
  it("missing directory data degrades safely", async () => {
    const empty = dir({ enquiry: async () => null, conversation: async () => null, review: async () => null, comment: async () => null, listingTitle: async () => null, businessName: async () => null });
    expect(await getKind("lead.accepted")!.resolve(TABLE[1]!.event as never, empty)).toEqual([]);
    expect(await getKind("message.received")!.resolve(TABLE[2]!.event as never, empty)).toEqual([]);
    expect(await getKind("quote.received")!.resolve(TABLE[4]!.event as never, empty)).toEqual([]);
    expect(await getKind("enquiry.under_review")!.resolve(TABLE[5]!.event as never, empty)).toEqual([]);
    expect(await getKind("review.moderated")!.resolve(TABLE[9]!.event as never, empty)).toEqual([]);
    expect(await getKind("comment.moderated")!.resolve(TABLE[12]!.event as never, empty)).toEqual([]);
    const [m] = await getKind("lead.matched")!.resolve(TABLE[0]!.event as never, empty);
    expect(m!.vars).toMatchObject({ enquiryTitle: "a new requirement", intentScore: "n/a" });
    const [rr] = await getKind("review.received")!.resolve(TABLE[11]!.event as never, empty);
    expect(rr!.vars.listingTitle).toBe("your product");
    const [li] = await getKind("listing.image_rejected")!.resolve(TABLE[8]!.event as never, empty);
    expect(li!.vars.listingTitle).toBe("your listing");
    const [rv] = await getKind("review.moderated")!.resolve(TABLE[9]!.event as never, dir({ listingTitle: async () => null }));
    expect(rv!.vars.listingTitle).toBe("the product");
    const [ca] = await getKind("lead.accepted")!.resolve(TABLE[1]!.event as never, dir({ businessName: async () => null }));
    expect(ca!.vars.sellerName).toBe("A seller");
  });
  it("a message sender is never notified of their own message (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("s1", "s2", "b1", "outsider"), async (sender) => {
        const out = await getKind("message.received")!.resolve(ev("MessageSent", { conversationId: "c", senderPersonId: sender }) as never, dir());
        expect(out.map((r) => r.personId)).not.toContain(sender);
      }),
    );
  });
  it("trust.badge_revoked fires only on a downward threshold crossing (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), fc.boolean(), async (from, to, active) => {
        const out = await getKind("trust.badge_revoked")!.resolve(ev("TrustScoreChanged", { businessId: SB, from, to, badgeActive: active }) as never, dir());
        expect(out.length > 0).toBe(!active && from >= 40 && to < 40);
      }),
    );
  });
});

describe("preference × consent matrix", () => {
  const stored = (m: number): Record<NotificationChannel, boolean> => ({ in_app: !!(m & 1), email: !!(m & 2), whatsapp: !!(m & 4), sms: !!(m & 8) });
  it("exhaustive: category × stored × consent", () => {
    for (const cat of CATEGORIES) for (let m = 0; m < 16; m++) for (const consent of [true, false]) {
      const s = stored(m);
      const e = effectiveChannels(cat, s, consent);
      if (cat === "security") expect([e.in_app, e.email]).toEqual([true, true]);
      else if (cat === "marketing" && !consent) expect([e.email, e.whatsapp, e.sms]).toEqual([false, false, false]);
      else expect(e).toEqual(s);
      if (cat === "marketing") expect(e.in_app).toBe(s.in_app);
      for (const ch of CHANNELS) if (e[ch] && !s[ch]) expect(cat).toBe("security"); // only security may force-enable
    }
  });
  it("locks and defaults", () => {
    expect(channelLock("security", "in_app")).toBe("required");
    expect(channelLock("security", "email")).toBe("required");
    expect(channelLock("security", "sms")).toBeNull();
    expect(channelLock("marketing", "in_app")).toBeNull();
    for (const ch of ["email", "whatsapp", "sms"] as const) expect(channelLock("marketing", ch)).toBe("consent");
    expect(channelLock("leads", "email")).toBeNull();
    for (const c of CATEGORIES) {
      const d = defaultPreference(c);
      expect(d.in_app).toBe(true);
      expect(d.whatsapp || d.sms).toBe(false);
    }
    expect(defaultPreference("marketing").email).toBe(false);
    expect(defaultPreference("security").email).toBe(true);
  });
});

describe("ops helpers and channels", () => {
  it("maskEmail / redact never leak addresses or phones (property)", () => {
    expect(maskEmail("mail asha@example.com now")).toBe("mail a***@example.com now");
    fc.assert(
      // The mask character is excluded from the local part: a local part of "*" legitimately masks to "****@a.aa",
      // which contains the original "*@a.aa" without leaking anything.
      fc.property(fc.emailAddress().filter((e) => !e.split("@")[0]!.includes("*")), fc.string({ minLength: 6, maxLength: 12 }), (email, phone) => {
        const out = JSON.stringify(redact({ to: email, nested: [{ contactPhone: phone, mobile: phone }], n: 3, ok: true, none: null }));
        expect(out).not.toContain(JSON.stringify(email).slice(1, -1));
      }),
    );
    expect(redact({ phone: "+919999999999" })).toEqual({ phone: "+91******99" });
    expect(redact(5)).toBe(5);
  });
  it("queue topics registry", () => {
    expect(listQueueTopics().map((t) => t.topic)).toEqual(expect.arrayContaining(["email.send", "notification.deliver"]));
    registerQueueTopic("x.topic", "desc");
    expect(listQueueTopics().find((t) => t.topic === "x.topic")?.description).toBe("desc");
  });
  it("absoluteUrl uses per-app base and trims trailing slash", () => {
    process.env.SELLER_APP_URL = "https://seller.example.com/";
    expect(absoluteUrl("seller", "/leads")).toBe("https://seller.example.com/leads");
    delete process.env.ADMIN_APP_URL;
    expect(absoluteUrl("admin", "/x")).toBe("http://localhost:3001/x");
    delete process.env.SELLER_APP_URL;
  });
  it("channel adapters: default stub masks number; custom adapter replaces and resets", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    await getChannelAdapter("sms").send({ personId: "p", to: "+919876543210", text: "hi", kind: "k" });
    expect(spy.mock.calls[0]![0]).toContain("+91******10");
    expect(spy.mock.calls[0]![0]).not.toContain("9876543210");
    spy.mockRestore();
    const sent: unknown[] = [];
    setChannelAdapter({ channel: "whatsapp", async send(m) { sent.push(m); } });
    await getChannelAdapter("whatsapp").send({ personId: "p", to: "1", text: "t", kind: "k" });
    expect(sent).toHaveLength(1);
    setChannelAdapter({ channel: "whatsapp", reset: true });
    expect(getChannelAdapter("whatsapp").channel).toBe("whatsapp");
    expect(getChannelAdapter("whatsapp")).not.toHaveProperty("sent");
  });
});
