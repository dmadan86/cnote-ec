// Default order-context port: composes enquiry/catalogue PUBLIC functions (ADR-006), never their tables.
import { listSellerListings } from "@cnote/catalogue";
import { getOrder, getSellerLead } from "@cnote/enquiry";
import { buildExpectedSpec } from "./spec";
import type { OrderContext, OrderContextPort, QualityActor } from "./types";

const tokens = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));

export const defaultOrderContextPort: OrderContextPort = {
  async load(actor: QualityActor, orderId: string): Promise<OrderContext | null> {
    const o = await getOrder(actor, orderId);
    if (!o) return null;
    if (o.role !== "seller") return { orderId: o.id, role: o.role, status: o.status, sellerBusinessId: o.counterparty.businessId, categorySlug: null, spec: buildExpectedSpec({ title: o.enquiryTitle, quantity: o.quantity, unit: o.unit, requirement: "" }) };
    const lead = o.matchId ? await getSellerLead(actor.businessId, o.matchId) : null; // network (ONDC) orders have no lead
    const categorySlug = lead?.enquiry.category?.slug ?? null;
    let attributes: Record<string, string | number> = {};
    if (categorySlug) {
      // Best effort: the seller's listing in this category whose title overlaps the order title most.
      const want = tokens(o.enquiryTitle);
      const best = (await listSellerListings(actor.businessId))
        .filter((l) => l.category.slug === categorySlug)
        .map((l) => ({ l, score: [...tokens(l.title)].filter((t) => want.has(t)).length }))
        .sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0) attributes = best.l.attributes;
    }
    return {
      orderId: o.id, role: "seller", status: o.status, sellerBusinessId: actor.businessId, categorySlug,
      spec: buildExpectedSpec({ title: o.enquiryTitle, quantity: o.quantity, unit: o.unit, requirement: lead?.enquiry.requirement ?? "", attributes }),
    };
  },
};

let port: OrderContextPort = defaultOrderContextPort;
export const getOrderContextPort = (): OrderContextPort => port;
/** Injection point (tests, and any future order-owning module that wants to serve richer context). */
export function setOrderContextPort(p: OrderContextPort | null): void { port = p ?? defaultOrderContextPort; }
