import type { DomainEvent } from "@cnote/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/templates", () => ({ defineTemplates: () => {}, isChannelEnabled: async () => true, renderText: async () => ({ title: "t", body: "b" }) }));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { getKind, templateDefinitions } from "../src/kinds";
import { SAMPLE_KINDS } from "../src/kinds-samples";
import type { Directory } from "../src/recipients";

const SB = "sb", BB = "bb";
const dir: Directory = {
  businessMembers: async (b) => (b === SB ? ["s1", "s2"] : b === BB ? ["b1"] : []),
  businessName: async (b) => (b === BB ? "Asha Traders\nBcc: x@evil.test" : "Sharma Packaging"),
  enquiry: async () => null, conversation: async () => null, listingTitle: async () => null, review: async () => null, comment: async () => null, contact: async () => null,
};
const base = { sampleId: "smp1", buyerBusinessId: BB, sellerBusinessId: SB };
const ev = (type: string, payload: object): DomainEvent => ({ id: 1, type, version: 1, aggregateType: "sample", aggregateId: "smp1", payload: { ...base, ...payload }, occurredAt: "2026-10-06T10:00:00.000Z" }) as never;
const run = (key: string, e: DomainEvent) => getKind(key)!.resolve(e as never, dir);
const ids = (rs: { personId: string }[]) => rs.map((r) => r.personId).sort();

describe("sample notification kinds", () => {
  it("are registered, transactional (leads category), have a Hindi seed and use only declared variables", () => {
    expect(SAMPLE_KINDS.length).toBeGreaterThanOrEqual(11);
    const defs = templateDefinitions();
    for (const k of SAMPLE_KINDS) {
      expect(getKind(k.key), k.key).toBe(k);
      expect(k.category, k.key).toBe("leads");
      expect(k.localized?.hi?.in_app?.body, k.key).toBeTruthy();
      const declared = new Set(k.variables.map((v) => v.name));
      for (const text of [k.defaults.in_app.body, k.localized!.hi!.in_app!.body]) for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) expect(declared.has(m[1]!), `${k.key}: {{${m[1]}}}`).toBe(true);
      // Hindi keeps exactly the English placeholders
      const ph = (s: string) => [...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      expect(ph(k.localized!.hi!.in_app!.body), k.key).toEqual(ph(k.defaults.in_app.body));
      expect(defs.some((d) => d.key === k.key), k.key).toBe(true);
    }
  });

  it("a new request goes to the supplier's members with the buyer name sanitised and the hours left", async () => {
    const r = await run("samples.requested", ev("SampleRequested", { listingId: null, quantity: 5, amountPaise: 0, respondBy: "2026-10-08T10:00:00.000Z" }));
    expect(ids(r)).toEqual(["s1", "s2"]);
    expect(getKind("samples.requested")!.app).toBe("seller");
    expect(r[0]).toMatchObject({ href: "/samples/smp1", vars: { quantity: 5, hours: 48 } });
    expect(String(r[0]!.vars.buyer)).not.toMatch(/[\r\n]/);
  });

  it("buyer-facing kinds go to the buyer's members, in the web app, on the buyer sample page", async () => {
    for (const [key, type, payload] of [
      ["samples.accepted", "SampleAccepted", { amountPaise: 0, adjustableAgainstBulk: false, expectedDispatchBy: null, responseMs: 1 }],
      ["samples.declined", "SampleDeclined", { reason: "other", responseMs: 1 }],
      ["samples.dispatched", "SampleDispatched", { courier: "Delhivery", trackingRef: null }],
      ["samples.evaluate", "SampleDelivered", { deliveredBy: "seller" }],
      ["samples.expired_buyer", "SampleExpired", {}],
    ] as const) {
      const r = await run(key, ev(type, payload));
      expect(ids(r), key).toEqual(["b1"]);
      expect(getKind(key)!.app, key).toBe("web");
      expect(r[0], key).toMatchObject({ href: "/buyer/samples/smp1" });
    }
    expect((await run("samples.dispatched", ev("SampleDispatched", { courier: "Delhivery", trackingRef: null })))[0]!.vars).toMatchObject({ courier: "Delhivery", tracking: "-" });
  });

  it("verdict, delivery and expiry kinds only fire for the matching case", async () => {
    expect(ids(await run("samples.approved", ev("SampleEvaluated", { approved: true, reasons: [], photoCount: 0 })))).toEqual(["s1", "s2"]);
    expect(await run("samples.rejected", ev("SampleEvaluated", { approved: true, reasons: [], photoCount: 0 }))).toEqual([]);
    expect(ids(await run("samples.rejected", ev("SampleEvaluated", { approved: false, reasons: ["other"], photoCount: 0 })))).toEqual(["s1", "s2"]);
    expect(await run("samples.approved", ev("SampleEvaluated", { approved: false, reasons: ["other"], photoCount: 0 }))).toEqual([]);
    // the buyer's own "received" does not notify the buyer; the seller hears about it only when the buyer confirmed
    expect(ids(await run("samples.received", ev("SampleDelivered", { deliveredBy: "buyer" })))).toEqual(["s1", "s2"]);
    expect(await run("samples.received", ev("SampleDelivered", { deliveredBy: "seller" }))).toEqual([]);
    expect(ids(await run("samples.expired_seller", ev("SampleExpired", {})))).toEqual(["s1", "s2"]);
    expect(ids(await run("samples.cancelled", ev("SampleCancelled", {})))).toEqual(["s1", "s2"]);
    expect(ids(await run("samples.bulk_requested", ev("SampleBulkQuoteRequested", { enquiryId: "e1" })))).toEqual(["s1", "s2"]);
  });
});
