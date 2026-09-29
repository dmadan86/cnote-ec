// Shared helpers: cross-module lookups through public contracts, row locks, view mappers.
import * as catalogue from "@cnote/catalogue";
import * as identity from "@cnote/identity";
import type { TrustProfile } from "@cnote/identity";
import type { Enquiry, Match, Tx } from "@cnote/db";
import type { CategoryView } from "@cnote/catalogue";
import type { EnquiryView, MatchView } from "./types";

export const RESPOND_WINDOW_MS = 2 * 60 * 60 * 1000; // ADR-002: decline/respond within 2h
export const REFUND_WINDOW_MS = 72 * 60 * 60 * 1000; // ADR-002: auto-refund window

let catCache: { at: number; list: CategoryView[] } | null = null;
export async function categories(): Promise<CategoryView[]> {
  if (catCache && Date.now() - catCache.at < 60_000) return catCache.list;
  const list = await catalogue.listCategories();
  catCache = { at: Date.now(), list };
  return list;
}
export async function categoryById(id: string | null): Promise<CategoryView | null> {
  if (!id) return null;
  return (await categories()).find((c) => c.id === id) ?? null;
}

export async function profiles(ids: string[]): Promise<Map<string, TrustProfile>> {
  const uniq = [...new Set(ids)];
  return uniq.length ? identity.getTrustProfiles(uniq) : new Map();
}

/**
 * Buyer contact for a person. Needs an identity export (`getPersonContact`, requested from the
 * identity owner); until it exists this degrades to "no phone" and the UI points to in-app chat.
 */
export async function personContact(personId: string): Promise<{ phone: string | null } | null> {
  const fn = (identity as unknown as Record<string, unknown>).getPersonContact;
  if (typeof fn !== "function") return null;
  return (await (fn as (id: string) => Promise<{ phone: string | null } | null>)(personId)) ?? null;
}

export async function lockRow(tx: Pick<Tx, "$queryRaw">, table: "matches" | "enquiries", id: string): Promise<void> {
  if (table === "matches") await tx.$queryRaw`SELECT id FROM matches WHERE id = ${id}::uuid FOR UPDATE`;
  else await tx.$queryRaw`SELECT id FROM enquiries WHERE id = ${id}::uuid FOR UPDATE`;
}

export const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function enquiryBase(e: Enquiry, cat: CategoryView | null): Omit<EnquiryView, "matches"> {
  return {
    id: e.id,
    title: e.title,
    requirement: e.requirement,
    category: cat ? { slug: cat.slug, name: cat.name } : null,
    quantity: e.quantity,
    quantityUnit: e.quantityUnit,
    targetPricePaise: e.targetPricePaise === null ? null : Number(e.targetPricePaise),
    deliveryCity: e.deliveryCity,
    deliveryPincode: e.deliveryPincode,
    neededBy: e.neededBy ? e.neededBy.toISOString().slice(0, 10) : null,
    intentScore: e.intentScore,
    intentReasons: strArr(e.intentReasons),
    status: e.status,
    createdAt: e.createdAt.toISOString(),
    buyerPicks: e.buyerPicks,
    sellerCap: e.sellerCap,
  };
}

export function matchView(m: Match, of: number, p: TrustProfile | undefined, conversationId: string | null): MatchView {
  return {
    id: m.id,
    enquiryId: m.enquiryId,
    sellerBusinessId: m.sellerBusinessId,
    sellerName: p?.name ?? "Seller",
    rank: m.rank,
    of,
    matchScore: m.matchScore,
    status: m.status,
    respondBy: m.respondBy.toISOString(),
    conversationId,
    seller: p ? { verificationTier: p.verificationTier, badgeActive: p.badgeActive, trustScore: p.trustScore, city: p.city } : undefined,
  };
}
