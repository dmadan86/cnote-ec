import type { DomainEvent } from "@cnote/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/templates", () => ({ defineTemplates: () => {}, isChannelEnabled: async () => true, renderText: async () => ({ title: "t", body: "b" }) }));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { getKind, kindsFor, templateDefinitions } from "../src/kinds";
import { GRN_KINDS } from "../src/kinds-grn";
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

const base = { orderId: "o1", buyerBusinessId: BB, sellerBusinessId: SB };

describe("goods receipt and return kinds", () => {
  it("are transactional, unique, registered, observe their event, and have Hindi seed copy with the same placeholders", () => {
    expect(new Set(GRN_KINDS.map((k) => k.key)).size).toBe(GRN_KINDS.length);
    for (const k of GRN_KINDS) {
      expect(["messages", "billing"]).toContain(k.category);
      expect(CATEGORIES).toContain(k.category);
      expect(getKind(k.key)).toBe(k);
      expect(kindsFor(k.event)).toContain(k);
      const names = new Set(k.variables.map((x) => x.name));
      const en = k.defaults.in_app;
      const hi = k.localized!.hi!.in_app!;
      const ph = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]!).sort();
      for (const p of ph(`${en.subject} ${en.body}`)) expect(names, `${k.key} uses {{${p}}}`).toContain(p);
      expect(ph(`${hi.subject} ${hi.body}`), `${k.key} hi placeholders`).toEqual(ph(`${en.subject} ${en.body}`));
      expect(hi.body).toMatch(/[^\x00-\x7f]/);
    }
    const defs = templateDefinitions().filter((d) => GRN_KINDS.some((k) => k.key === d.key));
    expect(defs).toHaveLength(GRN_KINDS.length);
    expect(defs.every((d) => d.category === "transactional" && d.localized?.hi)).toBe(true);
  });

  it("a goods receipt tells the seller's members; a return request and shipment too, with links into the returns inbox", async () => {
    const g = await run("grn.recorded", ev("GoodsReceiptRecorded", { ...base, goodsReceiptId: "g", number: "GRN/26-27/000004", purchaseOrderId: "p", receivedOn: "2026-10-05", acceptedUnits: 90, rejectedUnits: 10, deliveryConfirmed: true }));
    expect(ids(g)).toEqual(["s1", "s2"]);
    expect(g[0]).toMatchObject({ app: "seller", href: "/orders/o1/purchase-order", vars: { grnNumber: "GRN/26-27/000004", accepted: 90, rejected: 10 } });
    const r = await run("return.requested", ev("GoodsReturnRequested", { ...base, goodsReturnId: "r1", number: "RMA/26-27/000002", goodsReceiptId: "g", purchaseOrderId: "p", units: 10, estimatedPaise: 1, reasonCode: "damaged" }));
    expect(ids(r)).toEqual(["s1", "s2"]);
    expect(r[0]).toMatchObject({ app: "seller", href: "/returns/r1", vars: { returnNumber: "RMA/26-27/000002", units: 10 } });
    const s = await run("return.shipped", ev("GoodsReturnShipped", { ...base, goodsReturnId: "r1", number: "RMA/26-27/000002", hasTrackingRef: true }));
    expect(s[0]).toMatchObject({ app: "seller", href: "/returns/r1" });
  });

  it("the seller's decision reaches the buyer: approved and rejected are separate kinds", async () => {
    const dec = (decision: string) => ev("GoodsReturnDecided", { ...base, goodsReturnId: "r1", number: "RMA/26-27/000002", decision });
    expect(ids(await run("return.approved", dec("approved")))).toEqual(["b1"]);
    expect(await run("return.rejected", dec("approved"))).toEqual([]);
    expect(await run("return.approved", dec("rejected"))).toEqual([]);
    const r = await run("return.rejected", dec("rejected"));
    expect(r[0]).toMatchObject({ app: "web", href: "/buyer/returns/r1" });
  });

  it("a credit note tells the buyer the amount", async () => {
    const c = await run("return.credit_note", ev("ReturnCreditNoteRecorded", { ...base, creditNoteId: "c", goodsReturnId: "r1", returnNumber: "RMA/26-27/000002", supplierInvoiceId: "i", creditNoteNumber: "CN-1", totalPaise: 295_000, outstandingPaise: 0, refundDuePaise: 0, hasIrn: false }));
    expect(ids(c)).toEqual(["b1"]);
    expect(c[0]).toMatchObject({ app: "web", href: "/buyer/returns/r1", vars: { creditNoteNumber: "CN-1", amount: "₹2,950", returnNumber: "RMA/26-27/000002" } });
  });
});
