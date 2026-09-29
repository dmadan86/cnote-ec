import { MemoryJobQueue, setJobQueue, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  consents: { marketing: false } as Record<string, boolean>,
  enabled: new Set<string>(),
  sent: [] as unknown[],
}));

vi.mock("@cnote/templates", () => ({
  defineTemplates: () => {},
  isChannelEnabled: async (key: string, ch: string) => h.enabled.has(`${key}:${ch}`) || h.enabled.has(`*:${ch}`),
  renderText: async (key: string, _ch: string, vars: Record<string, unknown>) => ({ title: `T ${key} ${String(vars.enquiryTitle ?? "")}`, body: `B ${String(vars.href)}`, templateVersionId: null }),
}));
vi.mock("@cnote/email", () => ({ sendEmail: async (i: unknown) => { h.sent.push(i); return "id"; } }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => h.consents }));

import { getPreferences, setPreference } from "../src/preferences";
import { deliverJob, notifyForEvent } from "../src/pipeline";
import { listNotifications, markRead, unreadCount } from "../src/read";
import type { Directory } from "../src/recipients";
import { redis } from "@cnote/core";

const seller1 = randomUUID();
const seller2 = randomUUID();
const buyer = randomUUID();
const SB = randomUUID();
const BB = randomUUID();
const people = [seller1, seller2, buyer];
let nextId = Date.now();

const dir: Directory = {
  businessMembers: async (b) => (b === SB ? [seller1, seller2] : [buyer]),
  businessName: async () => "Sharma Textiles",
  enquiry: async () => ({ title: "Cotton yarn", intentScore: 82, buyerBusinessId: BB, buyerPersonId: buyer }),
  conversation: async () => ({ enquiryId: "e", enquiryTitle: "Cotton yarn", buyerBusinessId: BB, buyerName: "Acme", sellerBusinessId: SB, sellerName: "Sharma Textiles" }),
  listingTitle: async () => "Yarn",
  review: async () => null,
  comment: async () => null,
  contact: async (id) => ({ email: `${id}@example.com`, phone: "+919999999999", name: "Asha" }),
};

const ev = <T extends DomainEvent["type"]>(type: T, payload: unknown): DomainEvent => ({ id: nextId++, type, version: 1, aggregateType: "x", aggregateId: "x", payload: payload as never, occurredAt: new Date().toISOString() });
const matched = () => ev("LeadMatched", { enquiryId: "e", matchId: "m", sellerBusinessId: SB, rank: 1, matchScore: 0.9 });

beforeEach(async () => {
  h.consents = { marketing: false };
  h.enabled = new Set(["*:in_app", "*:email"]);
  h.sent = [];
  setJobQueue(new MemoryJobQueue());
  await prisma.notification.deleteMany({ where: { personId: { in: people } } });
  await prisma.notificationPreference.deleteMany({ where: { personId: { in: people } } });
  for (const p of people) await redis.del(`notif:unread:${p}:seller`, `notif:unread:${p}:web`);
});
afterAll(async () => {
  await prisma.notification.deleteMany({ where: { personId: { in: people } } });
  await prisma.notificationPreference.deleteMany({ where: { personId: { in: people } } });
});

describe("observer mapping", () => {
  it("LeadMatched notifies every seller member in the seller app", async () => {
    await notifyForEvent(matched(), dir);
    for (const p of [seller1, seller2]) {
      const { items } = await listNotifications(p, "seller");
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "lead.matched", href: "/leads", read: false });
      expect(items[0]!.title).toContain("Cotton yarn");
    }
    expect((await listNotifications(buyer, "seller")).items).toHaveLength(0);
  });

  it("MessageSent goes to the other party, in their app, never the sender", async () => {
    await notifyForEvent(ev("MessageSent", { conversationId: "c", messageId: "m", senderPersonId: seller1 }), dir);
    expect((await listNotifications(buyer, "web")).items).toHaveLength(1);
    expect((await listNotifications(seller1, "seller")).items).toHaveLength(0);
    expect((await listNotifications(seller2, "seller")).items).toHaveLength(0);
    await notifyForEvent(ev("MessageSent", { conversationId: "c", messageId: "m2", senderPersonId: buyer }), dir);
    expect((await listNotifications(seller1, "seller")).items).toHaveLength(1);
    expect((await listNotifications(seller2, "seller")).items).toHaveLength(1);
  });

  it("ignores events that need no notification (approved listing, no review needed)", async () => {
    await notifyForEvent(ev("ListingModerated", { listingId: "l", sellerBusinessId: SB, status: "approved" }), dir);
    await notifyForEvent(ev("EnquiryScored", { enquiryId: "e", intentScore: 80, needsReview: false }), dir);
    expect((await listNotifications(seller1, "seller")).items).toHaveLength(0);
    expect((await listNotifications(buyer, "web")).items).toHaveLength(0);
  });
});

describe("preferences and consent", () => {
  it("queues email by default for leads, skips it for reviews-like categories", async () => {
    const q = new MemoryJobQueue();
    setJobQueue(q);
    await notifyForEvent(matched(), dir);
    expect(await q.consume("notification.deliver", "g", "c", async () => {})).toBe(2);
    await notifyForEvent(ev("ListingModerated", { listingId: "l", sellerBusinessId: SB, status: "rejected", reason: "x" }), dir);
    expect(await q.consume("notification.deliver", "g", "c", async () => {})).toBe(0); // listings: email off by default
    expect((await listNotifications(seller1, "seller")).items).toHaveLength(2);
  });

  it("respects a person's opt-out per channel", async () => {
    const q = new MemoryJobQueue();
    setJobQueue(q);
    await setPreference(seller1, "leads", "email", false);
    await setPreference(seller2, "leads", "in_app", false);
    await notifyForEvent(matched(), dir);
    expect(await q.consume("notification.deliver", "g", "c", async () => {})).toBe(1); // only seller2's email
    expect((await listNotifications(seller1, "seller")).items).toHaveLength(1);
    expect((await listNotifications(seller2, "seller")).items).toHaveLength(0);
  });

  it("security email cannot be disabled; marketing needs consent", async () => {
    await expect(setPreference(seller1, "security", "email", false)).rejects.toThrow(/cannot be turned off/);
    await expect(setPreference(seller1, "marketing", "email", true)).rejects.toThrow(/privacy settings/);
    h.consents = { marketing: true };
    await setPreference(seller1, "marketing", "email", true);
    expect((await getPreferences(seller1)).marketing.email).toBe(true);
    expect((await getPreferences(seller2)).leads).toEqual({ in_app: true, email: true, whatsapp: false, sms: false });
  });

  it("deliverJob re-checks preferences and sends email with a dedupe key and absolute link", async () => {
    const job = { channel: "email" as const, kind: "lead.matched", eventId: 7, personId: seller1, businessId: SB, app: "seller" as const, vars: { enquiryTitle: "Cotton yarn" }, href: "/leads" };
    await deliverJob(job, dir);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ template: "lead.matched", dedupeKey: `lead.matched:7:${seller1}`, vars: { href: expect.stringMatching(/^https?:\/\/.+\/leads$/) } });
    await setPreference(seller1, "leads", "email", false);
    await deliverJob(job, dir);
    expect(h.sent).toHaveLength(1);
  });
});

describe("idempotency and unread cache", () => {
  it("redelivery of the same event creates no duplicate and enqueues no duplicate job", async () => {
    const q = new MemoryJobQueue();
    setJobQueue(q);
    const e = matched();
    await notifyForEvent(e, dir);
    await notifyForEvent(e, dir);
    expect((await listNotifications(seller1, "seller")).items).toHaveLength(1);
    expect(await q.consume("notification.deliver", "g", "c", async () => {})).toBe(2);
  });

  it("unread count is cached, busted on create and on read", async () => {
    expect(await unreadCount(seller1, "seller")).toBe(0); // primes the cache
    await notifyForEvent(matched(), dir);
    expect(await unreadCount(seller1, "seller")).toBe(1);
    await notifyForEvent(matched(), dir);
    expect(await unreadCount(seller1, "seller")).toBe(2);
    const { items } = await listNotifications(seller1, "seller");
    expect(await markRead(seller1, [items[0]!.id], "seller")).toBe(1);
    expect(await unreadCount(seller1, "seller")).toBe(1);
    expect(await markRead(seller1, "all", "seller")).toBe(1);
    expect(await unreadCount(seller1, "seller")).toBe(0);
    expect((await listNotifications(seller1, "seller", { unreadOnly: true })).items).toHaveLength(0);
  });

  it("markRead never touches another person's rows", async () => {
    await notifyForEvent(matched(), dir);
    const mine = (await listNotifications(seller1, "seller")).items[0]!.id;
    expect(await markRead(seller2, [mine], "seller")).toBe(0);
  });
});
