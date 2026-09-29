import { MemoryJobQueue, redis, setJobQueue, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ consents: { marketing: false } as Record<string, boolean>, enabled: new Set<string>(), sent: [] as any[], renders: [] as any[] }));
vi.mock("@cnote/templates", () => ({
  defineTemplates: () => {},
  isChannelEnabled: async (key: string, ch: string) => h.enabled.has(`${key}:${ch}`) || h.enabled.has(`*:${ch}`),
  renderText: async (key: string, ch: string, vars: Record<string, unknown>) => { h.renders.push({ key, ch, vars }); return { title: null, body: `B ${String(vars.href)}` }; },
}));
vi.mock("@cnote/email", () => ({ sendEmail: async (i: unknown) => { h.sent.push(i); return "id"; } }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => h.consents }));

import { bustUnread, cachedUnread } from "../src/cache";
import { setChannelAdapter } from "../src/channels";
import { getKind, KINDS } from "../src/kinds";
import { listDeadLetters, listEmailLog, replayDeadLetter } from "../src/ops";
import { channelsFor, getPreferences, setPreference } from "../src/preferences";
import { deliverJob, notifyForEvent, notifyRecipient, type NotificationDeliverJob } from "../src/pipeline";
import { listNotifications, markRead, unreadCount } from "../src/read";
import type { Directory } from "../src/recipients";
import { pruneReadNotifications, worker } from "../src/worker";

const P = randomUUID(), P2 = randomUUID(), SB = randomUUID();
const people = [P, P2];
let nid = Date.now() * 10;
const ev = (type: string, payload: unknown): DomainEvent => ({ id: nid++, type, version: 1, aggregateType: "x", aggregateId: "x", payload, occurredAt: new Date().toISOString() }) as never;
const dir = (over: Partial<Directory> = {}): Directory => ({
  businessMembers: async () => [P, P2], businessName: async () => "S", enquiry: async () => ({ title: "Y", intentScore: 1, buyerBusinessId: SB, buyerPersonId: P }),
  conversation: async () => null, listingTitle: async () => "L", review: async () => null, comment: async () => null,
  contact: async () => ({ email: "a@example.com", phone: "+919999999999", name: "Asha" }), ...over,
});
const matched = () => ev("LeadMatched", { enquiryId: "e", matchId: "m", sellerBusinessId: SB });
const job = (over: Partial<NotificationDeliverJob> = {}): NotificationDeliverJob => ({ channel: "email", kind: "lead.matched", eventId: 1, personId: P, businessId: SB, app: "seller", vars: { a: 1 }, href: "/leads", ...over });

beforeEach(async () => {
  h.consents = { marketing: false }; h.enabled = new Set(["*:in_app", "*:email"]); h.sent = []; h.renders = [];
  setJobQueue(new MemoryJobQueue());
  await prisma.notification.deleteMany({ where: { personId: { in: people } } });
  await prisma.notificationPreference.deleteMany({ where: { personId: { in: people } } });
  for (const p of people) await redis.del(...(["web", "seller", "admin"].map((a) => `notif:unread:${p}:${a}`)));
});
afterAll(async () => {
  await prisma.notification.deleteMany({ where: { personId: { in: people } } });
  await prisma.notificationPreference.deleteMany({ where: { personId: { in: people } } });
});

describe("preferences store", () => {
  it("validates category/channel, persists, merges defaults, ignores unknown stored categories", async () => {
    await expect(setPreference(P, "nope" as never, "email", true)).rejects.toMatchObject({ code: "validation" });
    await expect(setPreference(P, "leads", "pigeon" as never, true)).rejects.toMatchObject({ code: "validation" });
    await expect(setPreference(P, "security", "in_app", false)).rejects.toMatchObject({ code: "validation" });
    await setPreference(P, "security", "email", true); // enabling a required channel is fine
    await setPreference(P, "leads", "whatsapp", true);
    await setPreference(P, "leads", "email", false);
    await setPreference(P, "leads", "email", true); // update path
    await prisma.notificationPreference.create({ data: { personId: P, category: "legacy_cat", inApp: false, email: false, whatsapp: false, sms: false } });
    const m = await getPreferences(P);
    expect(m.leads).toEqual({ in_app: true, email: true, whatsapp: true, sms: false });
    expect(m.reviews.email).toBe(false);
    expect(Object.keys(m)).not.toContain("legacy_cat");
  });
  it("channelsFor applies consent only for marketing", async () => {
    h.consents = { marketing: true };
    await setPreference(P, "marketing", "email", true);
    expect((await channelsFor(P, "marketing")).email).toBe(true);
    h.consents = { marketing: false }; // consent withdrawn later
    expect((await channelsFor(P, "marketing")).email).toBe(false);
    expect((await channelsFor(P, "security")).email).toBe(true);
    expect((await channelsFor(P, "leads")).email).toBe(true);
  });
});

describe("notifyRecipient / notifyForEvent", () => {
  const kind = getKind("lead.matched")!;
  it("fans out to whatsapp/sms/email with exact job payloads and dedupe keys", async () => {
    const q = new MemoryJobQueue(); setJobQueue(q);
    h.enabled.add("*:whatsapp"); h.enabled.add("*:sms");
    await setPreference(P, "leads", "whatsapp", true);
    await setPreference(P, "leads", "sms", true);
    const e = matched();
    const res = await notifyRecipient(kind, e, { personId: P, businessId: SB, vars: { enquiryTitle: "Y" }, href: "/leads" });
    expect(res).toEqual({ created: true, queued: ["email", "whatsapp", "sms"] });
    const seen: NotificationDeliverJob[] = [];
    await q.consume("notification.deliver", "g", "c", async (m) => { seen.push(m.payload); });
    expect(seen.map((j) => j.channel)).toEqual(["email", "whatsapp", "sms"]);
    expect(seen[0]).toEqual({ channel: "email", kind: "lead.matched", eventId: e.id, personId: P, businessId: SB, app: "seller", vars: { enquiryTitle: "Y" }, href: "/leads" });
    // redelivery: row not duplicated, jobs deduped
    const again = await notifyRecipient(kind, e, { personId: P, businessId: SB, vars: {}, href: "/leads" });
    expect(again.created).toBe(false);
    expect(await q.consume("notification.deliver", "g", "c", async () => {})).toBe(0);
  });
  it("template-disabled channels are skipped; app override and null businessId are honoured", async () => {
    const q = new MemoryJobQueue(); setJobQueue(q);
    h.enabled = new Set(["*:in_app"]);
    const res = await notifyRecipient(kind, matched(), { personId: P, app: "web", vars: {}, href: "/x" });
    expect(res.queued).toEqual([]);
    const row = (await listNotifications(P, "web")).items[0]!;
    expect(row).toMatchObject({ app: "web", businessId: null, title: kind.name });
    h.enabled = new Set();
    expect(await notifyRecipient(kind, matched(), { personId: P, vars: {}, href: "/x" })).toEqual({ created: false, queued: [] });
  });
  it("in-app opt-out still delivers extra channels; bust failure never fails the write", async () => {
    const q = new MemoryJobQueue(); setJobQueue(q);
    await setPreference(P, "leads", "in_app", false);
    expect((await notifyRecipient(kind, matched(), { personId: P, vars: {}, href: "/x" })).queued).toEqual(["email"]);
    await setPreference(P, "leads", "in_app", true);
    const del = vi.spyOn(redis, "del").mockRejectedValue(new Error("redis down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await notifyRecipient(kind, matched(), { personId: P, vars: {}, href: "/x" })).created).toBe(true);
    expect(err).toHaveBeenCalled();
    del.mockRestore(); err.mockRestore();
  });
  it("marketing without consent gets in-app only", async () => {
    const mk = { ...kind, key: "mk.test", category: "marketing" as const };
    const q = new MemoryJobQueue(); setJobQueue(q);
    h.consents = { marketing: true };
    await setPreference(P, "marketing", "email", true);
    h.consents = { marketing: false };
    expect((await notifyRecipient(mk, matched(), { personId: P, vars: {}, href: "/x" })).queued).toEqual([]);
  });
  it("one recipient failing does not block others; first error rethrown for redelivery; resolve errors isolated", async () => {
    const spy = vi.spyOn(prisma.notification, "create").mockImplementationOnce((() => { throw new Error("boom"); }) as never);
    await expect(notifyForEvent(matched(), dir())).rejects.toThrow("boom");
    spy.mockRestore();
    expect((await listNotifications(P2, "seller")).items).toHaveLength(1);
    expect((await listNotifications(P, "seller")).items).toHaveLength(0);
    await notifyForEvent(matched(), dir()); // retry of a NEW event completes for both
    const bad = dir({ businessMembers: async () => { throw new Error("dir down"); } });
    await expect(notifyForEvent(matched(), bad)).rejects.toThrow("dir down");
  });
  it("duplicate recipients from a kind are notified once; unobserved events are no-ops", async () => {
    await notifyForEvent(matched(), dir({ businessMembers: async () => [P, P, P2] }));
    expect((await listNotifications(P, "seller")).items).toHaveLength(1);
    await notifyForEvent(ev("SomethingElse", {}), dir());
    expect(await prisma.notification.count({ where: { personId: P } })).toBe(1);
  });
  it("redelivery property: N deliveries of the same event yield exactly one row per recipient", async () => {
    const e = matched();
    await Promise.all(Array.from({ length: 4 }, () => notifyForEvent(e, dir())));
    expect(await prisma.notification.count({ where: { personId: { in: people }, sourceEventId: BigInt(e.id) } })).toBe(2);
  });
  it("every registered kind can create a row through the pipeline with its default app", async () => {
    for (const k of KINDS) {
      const e = ev("X", {});
      await notifyRecipient(k, e, { personId: P, vars: {}, href: "/h" });
    }
    const rows = await prisma.notification.findMany({ where: { personId: P } });
    expect(rows).toHaveLength(KINDS.length);
    expect(new Set(rows.map((r) => r.kind)).size).toBe(KINDS.length);
  });
});

describe("deliverJob", () => {
  it("drops retired kinds, disabled channels, erased people and missing addresses", async () => {
    await deliverJob(job({ kind: "retired.kind" }), dir());
    h.enabled = new Set();
    await deliverJob(job(), dir());
    h.enabled = new Set(["*:email"]);
    await deliverJob(job(), dir({ contact: async () => null }));
    await deliverJob(job(), dir({ contact: async () => ({ email: null, phone: null, name: null }) }));
    await deliverJob(job({ channel: "sms" }), dir({ contact: async () => ({ email: "a@b.co", phone: null, name: null }) }));
    expect(h.sent).toHaveLength(0);
  });
  it("email sends the recipient name and absolute link; sms/whatsapp go through the adapter with rendered text", async () => {
    await deliverJob(job(), dir());
    expect(h.sent[0]).toMatchObject({ to: { email: "a@example.com", personId: P, name: "Asha" }, vars: { recipientName: "Asha", a: 1 } });
    await deliverJob(job(), dir({ contact: async () => ({ email: "a@example.com", phone: null, name: null }) }));
    expect(h.sent[1].vars.recipientName).toBe("");
    const sent: any[] = [];
    setChannelAdapter({ channel: "sms", send: async (m) => { sent.push(m); } });
    await setPreference(P, "leads", "sms", true);
    h.enabled.add("*:sms");
    await deliverJob(job({ channel: "sms" }), dir());
    expect(sent).toEqual([{ personId: P, to: "+919999999999", text: expect.stringMatching(/^B https?:\/\/.*\/leads$/), kind: "lead.matched" }]);
    setChannelAdapter({ channel: "sms", reset: true });
  });
  it("respects preference changes made after enqueue", async () => {
    await setPreference(P, "leads", "email", false);
    await deliverJob(job(), dir());
    expect(h.sent).toHaveLength(0);
  });
});

describe("read API", () => {
  it("paginates newest-first with cursors, clamps limit, scopes by app, markRead edge cases", async () => {
    for (let i = 0; i < 5; i++) await prisma.notification.create({ data: { personId: P, kind: "k", app: "seller", title: `t${i}`, body: "b", createdAt: new Date(Date.now() - i * 1000) } });
    await prisma.notification.create({ data: { personId: P, kind: "k", app: "web", title: "w", body: "b" } });
    const p1 = await listNotifications(P, "seller", { limit: 2 });
    expect(p1.items.map((i) => i.title)).toEqual(["t0", "t1"]);
    const p2 = await listNotifications(P, "seller", { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.title)).toEqual(["t2", "t3"]);
    const p3 = await listNotifications(P, "seller", { limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((i) => i.title)).toEqual(["t4"]);
    expect(p3.nextCursor).toBeNull();
    expect((await listNotifications(P, "seller", { limit: 0 })).items).toHaveLength(1);
    expect((await listNotifications(P, "seller", { limit: 9999 })).items).toHaveLength(5);
    expect(await markRead(P, [], "seller")).toBe(0);
    expect(await markRead(P, "all", "web")).toBe(1);
    expect(await unreadCount(P, "seller")).toBe(5);
    expect(await unreadCount(P, "web")).toBe(0);
    expect(await markRead(P, "all", "web")).toBe(0);
  });
  it("cache: loader runs once per TTL and bust forces reload (both scoped and all-apps)", async () => {
    const load = vi.fn(async () => 7);
    expect(await cachedUnread(P2, "admin", load)).toBe(7);
    expect(await cachedUnread(P2, "admin", load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    await bustUnread(P2);
    await cachedUnread(P2, "admin", load);
    expect(load).toHaveBeenCalledTimes(2);
    await bustUnread(P2, "admin");
    await cachedUnread(P2, "admin", load);
    expect(load).toHaveBeenCalledTimes(3);
    await bustUnread(P2);
  });
});

describe("worker and prune", () => {
  it("prune removes only READ rows older than 90 days", async () => {
    const day = 86_400_000, now = new Date();
    const mk = (title: string, readAt: Date | null) => prisma.notification.create({ data: { personId: P, kind: "k", app: "web", title, body: "b", readAt } });
    await mk("old-read", new Date(now.getTime() - 100 * day));
    await mk("old-unread", null);
    await mk("recent-read", new Date(now.getTime() - 10 * day));
    expect(await pruneReadNotifications(now)).toBeGreaterThanOrEqual(1);
    const left = (await prisma.notification.findMany({ where: { personId: P } })).map((n) => n.title).sort();
    expect(left).toEqual(["old-unread", "recent-read"]);
    await worker.jobs![0]!.run();
  });
  it("worker handler and queue consumer drive the pipeline", async () => {
    expect((worker.handlers as Record<string, unknown>).SomethingUnknown).toBeUndefined();
    await worker.queues![0]!.handler({ payload: job({ kind: "retired.kind" }) } as never);
  });
});

describe("dead letters and email log", () => {
  it("lists redacted dead letters and replays exactly once", async () => {
    const q = new MemoryJobQueue(); setJobQueue(q);
    await q.enqueue("notification.deliver", job({ vars: { email: "asha@example.com", contactPhone: "+919876543210" } }), { maxAttempts: 1 });
    await q.consume("notification.deliver", "g", "c", async () => { throw new Error("x"); });
    const dl = await listDeadLetters("notification.deliver");
    expect(dl).toHaveLength(1);
    const s = JSON.stringify(dl[0]!.payload);
    expect(s).not.toContain("asha@example.com");
    expect(s).not.toContain("9876543210");
    expect(s).toContain("a***@example.com");
    expect(await replayDeadLetter("notification.deliver", dl[0]!.id)).toBe(true);
    expect(await replayDeadLetter("notification.deliver", dl[0]!.id)).toBe(false);
    expect(await listDeadLetters("notification.deliver")).toHaveLength(0);
    expect(await q.consume("notification.deliver", "g", "c", async () => {})).toBe(1);
  });
  it("email log filters, masks errors, paginates", async () => {
    const tag = `nt-${randomUUID()}`;
    const mk = (i: number, status: "sent" | "failed") => prisma.emailMessage.create({ data: { toMasked: "a***@x.com", template: tag, category: "transactional", subject: "s", status, lastError: status === "failed" ? "bounce for bob@example.com" : null, sentAt: status === "sent" ? new Date() : null, createdAt: new Date(Date.now() - i * 1000) } });
    for (let i = 0; i < 3; i++) await mk(i, i === 0 ? "failed" : "sent");
    try {
      const p1 = await listEmailLog({ template: tag.toUpperCase(), limit: 2 });
      expect(p1.items).toHaveLength(2);
      expect(p1.items[0]!.lastError).toBe("bounce for b***@example.com");
      expect(p1.items[1]!.sentAt).toBeTruthy();
      const p2 = await listEmailLog({ template: tag, limit: 2, cursor: p1.nextCursor! });
      expect(p2.items).toHaveLength(1);
      expect(p2.nextCursor).toBeNull();
      expect((await listEmailLog({ template: tag, status: "failed" })).items).toHaveLength(1);
      expect((await listEmailLog({ template: tag, status: "bogus" })).items).toHaveLength(3);
      expect((await listEmailLog({ template: tag, limit: 0 })).items).toHaveLength(1);
      expect(await listEmailLog()).toBeTruthy();
    } finally {
      await prisma.emailMessage.deleteMany({ where: { template: tag } });
    }
  });
});
