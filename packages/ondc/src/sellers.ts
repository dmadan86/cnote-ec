// Seller opt-in (ADR-017): explicit channel connection with terms acceptance, then per-listing opt-in.
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import type { ListingView } from "@cnote/catalogue";
import { ineligibleReason, type IneligibleReason } from "./mapping";
import { getSource } from "./source";

export const TERMS_VERSION = "2026-09-v1";
const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (s: string) => UUID.test(s);

export interface SellerActor { personId: string; businessId: string }

export interface OndcSellerState {
  connected: boolean;
  enabled: boolean;
  termsVersion: string | null;
  acceptedAt: string | null;
  publishedItems: number;
  lastPublishedAt: string | null;
}

export async function getSellerState(businessId: string): Promise<OndcSellerState> {
  const row = isUuid(businessId) ? await prisma.ondcSeller.findUnique({ where: { businessId } }) : null;
  return {
    connected: !!row, enabled: row?.enabled ?? false, termsVersion: row?.termsVersion ?? null,
    acceptedAt: row?.acceptedAt.toISOString() ?? null, publishedItems: row?.publishedItems ?? 0, lastPublishedAt: row?.lastPublishedAt?.toISOString() ?? null,
  };
}

/** Connects (or re-enables) the seller. Requires the caller to pass the terms version being accepted. */
export async function connectSeller(actor: SellerActor, input: { acceptTermsVersion: string }): Promise<OndcSellerState> {
  if (input.acceptTermsVersion !== TERMS_VERSION) throw new DomainError("validation", "Please review and accept the current ONDC seller terms.");
  await prisma.ondcSeller.upsert({
    where: { businessId: actor.businessId },
    create: { businessId: actor.businessId, termsVersion: TERMS_VERSION, acceptedAt: new Date(), acceptedByPersonId: actor.personId },
    update: { enabled: true, termsVersion: TERMS_VERSION, acceptedAt: new Date(), acceptedByPersonId: actor.personId },
  });
  return getSellerState(actor.businessId);
}

/** Stops publishing immediately (catalogue drops out of every future on_search). Opt-ins are kept. */
export async function disconnectSeller(actor: SellerActor): Promise<OndcSellerState> {
  await prisma.ondcSeller.updateMany({ where: { businessId: actor.businessId }, data: { enabled: false } });
  return getSellerState(actor.businessId);
}

/** Opts one of the seller's own listings in/out. The listing must belong to the seller. */
export async function setListingOptIn(actor: SellerActor, listingId: string, optedIn: boolean, ondcCategoryId?: string | null): Promise<void> {
  if (!isUuid(listingId)) throw new DomainError("not_found", "Listing not found.");
  const mine = (await getSource().working(actor.businessId)).some((l) => l.id === listingId);
  if (!mine) throw new DomainError("not_found", "Listing not found.");
  if (!optedIn) {
    await prisma.ondcListingOptIn.deleteMany({ where: { listingId, sellerBusinessId: actor.businessId } });
    return;
  }
  const cat = ondcCategoryId?.trim().slice(0, 100) || null;
  await prisma.ondcListingOptIn.upsert({
    where: { listingId },
    create: { listingId, sellerBusinessId: actor.businessId, ondcCategoryId: cat },
    update: { ondcCategoryId: cat },
  });
}

export interface ListingOptInRow {
  listingId: string;
  title: string;
  optedIn: boolean;
  /** why it is not being published right now (null = publishable) */
  reason: IneligibleReason | null;
}

/** The seller's listings with their opt-in and publish eligibility. */
export async function listSellerListingOptIns(businessId: string): Promise<ListingOptInRow[]> {
  const [working, live, opts] = await Promise.all([
    getSource().working(businessId),
    getSource().live(businessId),
    prisma.ondcListingOptIn.findMany({ where: { sellerBusinessId: businessId }, select: { listingId: true } }),
  ]);
  const liveById = new Map<string, ListingView>(live.map((l) => [l.id, l]));
  const opted = new Set(opts.map((o) => o.listingId));
  return working.filter((l) => l.status !== "archived").map((l) => ({
    listingId: l.id, title: l.title, optedIn: opted.has(l.id),
    // a listing that is not in the live projection cannot be published, whatever its working status says
    reason: ineligibleReason(liveById.get(l.id) ?? { ...l, status: "draft" }, opted.has(l.id)),
  }));
}
