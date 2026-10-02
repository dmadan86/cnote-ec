// Buyer retention alerts through the real pipeline: BuyerAlertTriggered -> kind -> preferences -> Notification row / email job.
import { MemoryJobQueue, setJobQueue, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ rendered: [] as { key: string; vars: Record<string, unknown> }[] }));
vi.mock("@cnote/templates", () => ({
  defineTemplates: () => {},
  isChannelEnabled: async () => true,
  renderText: async (key: string, _ch: string, vars: Record<string, unknown>) => { h.rendered.push({ key, vars }); return { title: key, body: `B ${String(vars.label ?? "")}` }; },
}));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { setAlertSetting, verifyUnsubscribeToken } from "@cnote/alerts";
import { ALERT_KINDS } from "../src/kinds-alerts";
import { getKind, kindsFor, templateDefinitions } from "../src/kinds";
import { channelsFor, defaultPreference, setPreference } from "../src/preferences";
import { notifyForEvent, type NotificationDeliverJob } from "../src/pipeline";
import { listNotifications } from "../src/read";
import { worker } from "../src/worker";

const P = randomUUID();
let nid = Date.now() * 10;
const ev = (payload: Record<string, unknown>): DomainEvent => ({ id: nid++, type: "BuyerAlertTriggered", version: 1, aggregateType: "x", aggregateId: "x", payload: { personId: P, subjectId: null, label: "", count: 1, fromPricePaise: null, toPricePaise: null, href: "/x", ...payload }, occurredAt: "" }) as never;
const contact = async () => ({ email: "a@example.com", phone: null, name: "Asha" });
const dir = { businessMembers: async () => [], businessName: async () => null, enquiry: async () => null, conversation: async () => null, listingTitle: async () => null, review: async () => null, comment: async () => null, contact } as never;

beforeEach(async () => {
  h.rendered = [];
  setJobQueue(new MemoryJobQueue());
  await prisma.notification.deleteMany({ where: { personId: P } });
  await prisma.notificationPreference.deleteMany({ where: { personId: P } });
  await prisma.alertSettings.deleteMany({ where: { personId: P } });
});
afterAll(async () => {
  await prisma.notification.deleteMany({ where: { personId: P } });
  await prisma.notificationPreference.deleteMany({ where: { personId: P } });
  await prisma.alertSettings.deleteMany({ where: { personId: P } });
});

describe("alert kinds", () => {
  it("are four opt-in kinds in the alerts category, mapped to the 'alert' email template category with Hindi seed copy", () => {
    expect(ALERT_KINDS.map((k) => k.key)).toEqual(["alert.price_drop", "alert.back_in_stock", "alert.followed_digest", "alert.saved_search"]);
    expect(kindsFor("BuyerAlertTriggered")).toHaveLength(4);
    for (const k of ALERT_KINDS) {
      expect(k.category).toBe("alerts");
      expect(k.app).toBe("web");
      expect(k.localized?.hi?.in_app?.body).toBeTruthy();
      const names = new Set(k.variables.map((x) => x.name));
      expect(names).toContain("unsubscribeUrl");
      for (const c of [k.defaults.in_app, k.defaults.email, k.localized?.hi?.in_app, k.localized?.hi?.email]) {
        for (const m of `${c?.subject ?? ""} ${c?.body ?? ""}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) expect(names, `${k.key} uses {{${m[1]}}}`).toContain(m[1]);
      }
    }
    expect(templateDefinitions().filter((d) => d.key.startsWith("alert.")).every((d) => d.category === "alert" && d.channels.includes("email"))).toBe(true);
  });

  it("alert preferences default to channel-on (the opt-in lives in @cnote/alerts) and can be muted per channel", async () => {
    expect(defaultPreference("alerts")).toMatchObject({ in_app: true, email: true });
    await setPreference(P, "alerts", "email", false);
    expect((await channelsFor(P, "alerts")).email).toBe(false);
  });

  it("price drop: in-app + email job carrying a signed unsubscribe link for that type", async () => {
    await setAlertSetting(P, "price_drop", true);
    const q = new MemoryJobQueue();
    setJobQueue(q);
    const e = ev({ alertType: "price_drop", label: "Corrugated box", fromPricePaise: 15000, toPricePaise: 12000, href: "/p/abc" });
    await notifyForEvent(e, dir);
    const row = (await listNotifications(P, "web")).items[0]!;
    expect(row).toMatchObject({ kind: "alert.price_drop", href: "/p/abc", app: "web" });
    const jobs: NotificationDeliverJob[] = [];
    await q.consume("notification.deliver", "g", "c", async (m) => { jobs.push(m.payload); });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ channel: "email", kind: "alert.price_drop", personId: P });
    expect(jobs[0]!.vars).toMatchObject({ label: "Corrugated box", fromPrice: "₹150", toPrice: "₹120" });
    const token = decodeURIComponent(String(jobs[0]!.vars.unsubscribeUrl).split("t=")[1]!);
    expect(verifyUnsubscribeToken(token)).toEqual({ personId: P, type: "price_drop" });
    // redelivery of the same event does not duplicate
    await notifyForEvent(e, dir);
    expect((await listNotifications(P, "web")).items).toHaveLength(1);
  });

  it("an alert type the person switched off (or never on) is dropped even if the event is already queued", async () => {
    const q = new MemoryJobQueue();
    setJobQueue(q);
    await notifyForEvent(ev({ alertType: "price_drop", label: "X" }), dir);
    await notifyForEvent(ev({ alertType: "back_in_stock", label: "X" }), dir);
    await notifyForEvent(ev({ alertType: "followed_digest", label: "", count: 3 }), dir);
    expect((await listNotifications(P, "web")).items).toHaveLength(0);
    await setAlertSetting(P, "followed_digest", true);
    await notifyForEvent(ev({ alertType: "followed_digest", label: "", count: 3 }), dir);
    expect((await listNotifications(P, "web")).items.map((i) => i.kind)).toEqual(["alert.followed_digest"]);
  });

  it("each event reaches only the kind for its alert type; saved searches need no setting (the frequency is the opt-in)", async () => {
    await setAlertSetting(P, "back_in_stock", true);
    await notifyForEvent(ev({ alertType: "back_in_stock", label: "Yarn" }), dir);
    await notifyForEvent(ev({ alertType: "saved_search", label: "cotton yarn", count: 4, href: "/account/saved-searches" }), dir);
    const kinds = (await listNotifications(P, "web")).items.map((i) => i.kind).sort();
    expect(kinds).toEqual(["alert.back_in_stock", "alert.saved_search"]);
    expect(getKind("alert.saved_search")!.category).toBe("alerts");
    expect(h.rendered.find((r) => r.key === "alert.saved_search")!.vars).toMatchObject({ label: "cotton yarn", count: 4 });
  });

  it("muting the in-app and email channels in notification preferences silences every alert", async () => {
    await setAlertSetting(P, "price_drop", true);
    await setPreference(P, "alerts", "in_app", false);
    await setPreference(P, "alerts", "email", false);
    const q = new MemoryJobQueue();
    setJobQueue(q);
    await notifyForEvent(ev({ alertType: "price_drop", label: "X", fromPricePaise: 2, toPricePaise: 1 }), dir);
    expect((await listNotifications(P, "web")).items).toHaveLength(0);
    expect(await q.consume("notification.deliver", "g", "c", async () => {})).toBe(0);
  });

  it("the worker observes BuyerAlertTriggered", () => {
    expect(Object.keys(worker.handlers ?? {})).toContain("BuyerAlertTriggered");
  });
});
