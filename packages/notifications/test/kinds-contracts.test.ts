import type { DomainEvent } from "@cnote/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/templates", () => ({ defineTemplates: () => {}, isChannelEnabled: async () => true, renderText: async () => ({ title: "t", body: "b" }) }));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { CONTRACT_KINDS } from "../src/kinds-contracts";
import { getKind, kindsFor, templateDefinitions } from "../src/kinds";
import type { Directory } from "../src/recipients";
import { CATEGORIES } from "../src/types";

const SB = "sb", BB = "bb";
const dir: Directory = {
  businessMembers: async (b: string) => (b === SB ? ["s1", "s2"] : b === BB ? ["b1"] : []),
  businessName: async () => "X", enquiry: async () => null, conversation: async () => null, listingTitle: async () => null, review: async () => null, comment: async () => null, contact: async () => null,
} as never;
const ev = (type: string, payload: unknown): DomainEvent => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: "x", payload, occurredAt: "" }) as never;
const run = (key: string, e: DomainEvent) => getKind(key)!.resolve(e as never, dir);
const ids = (rs: { personId: string }[]) => rs.map((r) => r.personId).sort();

const c = { contractId: "c1", number: "RC/26-27/000003", buyerBusinessId: BB, sellerBusinessId: SB };

describe("rate contract kinds", () => {
  it("are transactional, unique, in the registry, observe their event, and have Hindi seed copy with the same placeholders", () => {
    expect(CONTRACT_KINDS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(CONTRACT_KINDS.map((k) => k.key)).size).toBe(CONTRACT_KINDS.length);
    for (const k of CONTRACT_KINDS) {
      expect(CATEGORIES).toContain(k.category);
      expect(k.category).toBe("messages");
      expect(getKind(k.key)).toBe(k);
      expect(kindsFor(k.event)).toContain(k);
      const names = new Set(k.variables.map((x) => x.name));
      const en = k.defaults.in_app;
      const hi = k.localized!.hi!.in_app!;
      const ph = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).sort();
      for (const p of ph(`${en.subject} ${en.body}`)) expect(names, `${k.key} uses {{${p}}}`).toContain(p);
      expect(ph(`${hi.subject} ${hi.body}`), `${k.key} hi placeholders`).toEqual(ph(`${en.subject} ${en.body}`));
      expect(hi.body).toMatch(/[^\x00-\x7f]/);
      expect(k.localized!.hi!.email).toBeDefined();
    }
    const defs = templateDefinitions().filter((d) => CONTRACT_KINDS.some((k) => k.key === d.key));
    expect(defs).toHaveLength(CONTRACT_KINDS.length);
    expect(defs.every((d) => d.category === "transactional" && d.localized?.hi)).toBe(true);
  });

  it("copy never says a contract renews by itself", () => {
    for (const k of CONTRACT_KINDS) {
      const text = `${k.defaults.in_app.subject} ${k.defaults.in_app.body}`;
      expect(text, k.key).not.toMatch(/will (be )?renew(ed)? automatically|auto-?renew/i);
    }
    expect(getKind("contract.expiry_30")!.defaults.in_app.body).toMatch(/will not renew by itself/);
  });

  it("a first proposal reaches the seller; later revisions use the amendment kind and go to the other side", async () => {
    const first = ev("RateContractProposed", { ...c, revision: 1, proposedByBusinessId: BB, amendment: false, validFrom: "2026-10-06", validTo: "2027-10-05" });
    const r = await run("contract.proposed", first);
    expect(ids(r)).toEqual(["s1", "s2"]);
    expect(r[0]).toMatchObject({ app: "seller", href: "/contracts/c1", vars: { contractNumber: c.number } });
    expect(await run("contract.amended", first)).toEqual([]);

    const counter = ev("RateContractProposed", { ...c, revision: 2, proposedByBusinessId: SB, amendment: false, validFrom: "2026-10-06", validTo: "2027-10-05" });
    expect(await run("contract.proposed", counter)).toEqual([]);
    const a = await run("contract.amended", counter);
    expect(ids(a)).toEqual(["b1"]);
    expect(a[0]).toMatchObject({ app: "web", href: "/buyer/contracts/c1", vars: { revision: 2 } });
  });

  it("activation, expiry reach both sides, each in its own app", async () => {
    const act = await run("contract.activated", ev("RateContractActivated", { ...c, revision: 1, amendment: false, validFrom: "2026-10-06", validTo: "2027-03-31" }));
    expect(ids(act)).toEqual(["b1", "s1", "s2"]);
    expect(act.find((x) => x.personId === "b1")).toMatchObject({ app: "web", href: "/buyer/contracts/c1", vars: { validFrom: "6 Oct 2026", validTo: "31 Mar 2027" } });
    expect(act.find((x) => x.personId === "s1")).toMatchObject({ app: "seller", href: "/contracts/c1" });
    const exp = await run("contract.expired", ev("RateContractExpired", { ...c, validTo: "2027-03-31" }));
    expect(ids(exp)).toEqual(["b1", "s1", "s2"]);
  });

  it("a decline and a termination tell the other party only", async () => {
    const rej = await run("contract.rejected", ev("RateContractRejected", { ...c, revision: 1, rejectedByBusinessId: SB, reason: "  Price \n too low " }));
    expect(ids(rej)).toEqual(["b1"]);
    expect(rej[0]).toMatchObject({ vars: { reason: "Price too low" } });
    expect(ids(await run("contract.terminated", ev("RateContractTerminated", { ...c, terminatedByBusinessId: BB, reason: "x" })))).toEqual(["s1", "s2"]);
    expect(ids(await run("contract.terminated", ev("RateContractTerminated", { ...c, terminatedByBusinessId: SB, reason: "x" })))).toEqual(["b1"]);
  });

  it("a call-off tells the seller, linking the order, with the pre-tax value", async () => {
    const r = await run("contract.call_off", ev("RateContractCallOffPlaced", { ...c, callOffId: "co", callOffNo: 3, orderId: "o9", taxablePaise: 2_950_000, lineCount: 2 }));
    expect(ids(r)).toEqual(["s1", "s2"]);
    expect(r[0]).toMatchObject({ app: "seller", href: "/orders/o9", vars: { callOffNo: 3, amount: "₹29,500" } });
  });

  it("each consumption threshold maps to exactly one kind, addressed to both sides", async () => {
    const w = (threshold: number, scope: "item" | "value") => ev("RateContractConsumptionWarning", { ...c, scope, itemKey: scope === "item" ? "k" : null, itemDescription: scope === "item" ? "Box" : null, threshold, usedPercent: threshold });
    expect(await run("contract.usage_100", w(80, "item"))).toEqual([]);
    expect(await run("contract.usage_80", w(100, "item"))).toEqual([]);
    const r = await run("contract.usage_80", w(80, "item"));
    expect(ids(r)).toEqual(["b1", "s1", "s2"]);
    expect(r[0]!.vars.what).toBe("Box");
    expect((await run("contract.usage_100", w(100, "value")))[0]!.vars.what).toBe("the total value");
  });

  it("each expiry reminder stage maps to exactly one kind", async () => {
    const e = (daysLeft: number) => ev("RateContractExpiryReminder", { ...c, daysLeft, validTo: "2027-03-31" });
    expect(await run("contract.expiry_7", e(30))).toEqual([]);
    expect(await run("contract.expiry_30", e(7))).toEqual([]);
    expect(ids(await run("contract.expiry_30", e(30)))).toEqual(["b1", "s1", "s2"]);
    expect((await run("contract.expiry_7", e(7)))[0]).toMatchObject({ vars: { validTo: "31 Mar 2027" } });
  });
});
