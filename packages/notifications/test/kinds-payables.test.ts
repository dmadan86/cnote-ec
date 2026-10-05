import type { DomainEvent } from "@cnote/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/templates", () => ({ defineTemplates: () => {}, isChannelEnabled: async () => true, renderText: async () => ({ title: "t", body: "b" }) }));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { getKind, kindsFor, templateDefinitions } from "../src/kinds";
import { niceDate, PAYABLE_KINDS } from "../src/kinds-payables";
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

const po = { purchaseOrderId: "p", orderId: "o1", number: "PO/26-27/000012", buyerBusinessId: BB, sellerBusinessId: SB };
const inv = { supplierInvoiceId: "i", purchaseOrderId: "p", orderId: "o1", buyerBusinessId: BB, sellerBusinessId: SB, invoiceNumber: "INV-1" };

describe("purchase order and payable kinds", () => {
  it("are transactional, unique, in the registry, observe their event, and have Hindi seed copy with the same placeholders", () => {
    expect(new Set(PAYABLE_KINDS.map((k) => k.key)).size).toBe(PAYABLE_KINDS.length);
    for (const k of PAYABLE_KINDS) {
      expect(CATEGORIES).toContain(k.category);
      expect(["messages", "billing"]).toContain(k.category);
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
    const defs = templateDefinitions().filter((d) => PAYABLE_KINDS.some((k) => k.key === d.key));
    expect(defs).toHaveLength(PAYABLE_KINDS.length);
    expect(defs.every((d) => d.category === "transactional" && d.localized?.hi)).toBe(true);
  });

  it("po.issued / po.amended reach the seller's members in the seller app with the order link", async () => {
    const r = await run("po.issued", ev("PurchaseOrderIssued", { ...po, version: 1, totalPaise: 2_950_000, paymentTermsDays: 30 }));
    expect(ids(r)).toEqual(["s1", "s2"]);
    expect(r[0]).toMatchObject({ app: "seller", href: "/orders/o1/purchase-order", vars: { poNumber: po.number, amount: "₹29,500" } });
    const a = await run("po.amended", ev("PurchaseOrderAmended", { ...po, version: 2, previousVersion: 1, totalPaise: 100_000, paymentTermsDays: 30 }));
    expect(a[0]).toMatchObject({ vars: { version: 2 } });
  });

  it("the seller's answer reaches the buyer: accepted and rejected are separate kinds", async () => {
    const acc = ev("PurchaseOrderAcknowledged", { ...po, version: 1, decision: "accepted", reason: null });
    const rej = ev("PurchaseOrderAcknowledged", { ...po, version: 1, decision: "rejected", reason: "  Price \n too low " });
    expect(ids(await run("po.accepted", acc))).toEqual(["b1"]);
    expect(await run("po.rejected", acc)).toEqual([]);
    expect(await run("po.accepted", rej)).toEqual([]);
    const r = await run("po.rejected", rej);
    expect(r[0]).toMatchObject({ app: "web", href: "/buyer/orders/o1/purchase-order", vars: { reason: "Price too low" } });
  });

  it("cancellation tells the other party", async () => {
    const byBuyer = await run("po.cancelled", ev("PurchaseOrderCancelled", { ...po, cancelledByBusinessId: BB, reason: "x" }));
    expect(ids(byBuyer)).toEqual(["s1", "s2"]);
    const bySeller = await run("po.cancelled", ev("PurchaseOrderCancelled", { ...po, cancelledByBusinessId: SB, reason: "x" }));
    expect(ids(bySeller)).toEqual(["b1"]);
  });

  it("invoice recorded tells the buyer the pay-by date; a payment tells the seller", async () => {
    const r = await run("invoice.recorded", ev("SupplierInvoiceRecorded", { ...inv, totalPaise: 1_180_000, dueDate: "2026-10-31", msmeCovered: true, hasIrn: false, hasEwayBill: false }));
    expect(ids(r)).toEqual(["b1"]);
    expect(r[0]).toMatchObject({ href: "/buyer/payables", vars: { invoiceNumber: "INV-1", amount: "₹11,800", dueDate: "31 Oct 2026" } });
    const p = await run("invoice.payment_recorded", ev("SupplierInvoicePaymentRecorded", { ...inv, amountPaise: 500_000, paidOn: "2026-10-05", fullyPaid: false, msmeCovered: true, late: false }));
    expect(ids(p)).toEqual(["s1", "s2"]);
    expect(p[0]).toMatchObject({ app: "seller", vars: { amount: "₹5,000" } });
  });

  it("each reminder stage maps to exactly one kind, addressed to the buyer", async () => {
    const mk = (stage: string) => ev("SupplierInvoiceDueReminder", { ...inv, stage, dueDate: "2026-10-31", outstandingPaise: 118_000, daysOverdue: stage === "overdue" ? 3 : 0 });
    for (const [stage, key] of [["t7", "payable.due_t7"], ["t1", "payable.due_t1"], ["overdue", "payable.overdue"]] as const) {
      for (const other of ["payable.due_t7", "payable.due_t1", "payable.overdue"]) {
        const r = await run(other, mk(stage));
        if (other === key) {
          expect(ids(r)).toEqual(["b1"]);
          expect(r[0]).toMatchObject({ app: "web", href: "/buyer/payables", vars: { invoiceNumber: "INV-1", amount: "₹1,180", dueDate: "31 Oct 2026" } });
        } else expect(r).toEqual([]);
      }
    }
    expect((await run("payable.overdue", mk("overdue")))[0]!.vars.daysOverdue).toBe(3);
  });

  it("formats dates on the Indian calendar", () => {
    expect(niceDate("2026-01-05")).toBe("5 Jan 2026");
    expect(niceDate("garbage")).toBe("garbage");
  });
});
