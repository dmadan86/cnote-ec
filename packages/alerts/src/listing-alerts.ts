// Price-drop, back-in-stock and listing-relisted alerts on wishlist items, triggered by catalogue domain events:
//  - ListingPriceChanged                      -> "price_drop"
//  - ListingAvailabilityChanged (out_of_stock -> in_stock | made_to_order) -> "back_in_stock": a REAL stock transition
//  - ListingPublished (an unpublished listing returns)                      -> "listing_relisted": "live again", not a stock claim
// "back_in_stock" and "listing_relisted" share ONE opt-in (the buyer's "back in stock" toggle: both mean "available to order again").
// Only people who opted in are touched; delivery honours the notification preferences. Handlers are idempotent (at-least-once delivery): every (event, person)
// pair is claimed in the AlertDispatch ledger inside the transaction that emits the alert.
import { getPublicListingsByIds } from "@cnote/catalogue";
import { emit, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { listSaversOfListing } from "@cnote/wishlist";
import { claimDispatch, filterOptedIn } from "./settings";

type Kind = "price_drop" | "back_in_stock" | "listing_relisted";
/** The opt-in switch that governs each alert kind. */
const SETTING: Record<Kind, "price_drop" | "back_in_stock"> = { price_drop: "price_drop", back_in_stock: "back_in_stock", listing_relisted: "back_in_stock" };

async function fanOut(kind: Kind, event: { id: number }, listingId: string, prices: { from: number | null; to: number | null }, availability?: "in_stock" | "made_to_order"): Promise<number> {
  const savers = await listSaversOfListing(listingId);
  if (!savers.length) return 0;
  const opted = await filterOptedIn(savers.map((s) => s.personId), SETTING[kind]);
  if (!opted.size) return 0;
  const listing = (await getPublicListingsByIds([listingId]).catch(() => []))[0];
  if (!listing) return 0; // not publicly visible (any more): nothing to point the buyer at
  if (kind === "back_in_stock" && listing.availability === "out_of_stock") return 0; // flipped back out before we got to it
  let sent = 0;
  for (const s of savers) {
    if (!opted.has(s.personId)) continue;
    const done = await prisma.$transaction(async (tx) => {
      if (!(await claimDispatch(tx, s.personId, `${kind}:${event.id}:${s.personId}`, SETTING[kind]))) return false;
      await emit(tx, "BuyerAlertTriggered", { type: "Listing", id: listingId }, {
        personId: s.personId, alertType: kind, subjectId: listingId, label: listing.title, count: 1, fromPricePaise: prices.from, toPricePaise: prices.to, href: `/p/${listingId}`,
        ...(availability ? { availability } : {}),
      });
      return true;
    });
    if (done) sent++;
  }
  return sent;
}

/** A lower price on the same unit. Raises, "price on request" and unit changes are not drops. */
export async function onListingPriceChanged(e: DomainEvent<"ListingPriceChanged">): Promise<number> {
  const { listingId, fromPricePaise: from, toPricePaise: to, fromPriceUnit, priceUnit } = e.payload;
  if (from === null || to === null || to >= from || fromPriceUnit !== priceUnit) return 0;
  return fanOut("price_drop", e, listingId, { from, to });
}

/**
 * The listing's effective availability changed. Only out_of_stock -> in_stock | made_to_order is a "back in stock"; going out of
 * stock, or in_stock <-> made_to_order, alerts nobody.
 */
export async function onListingAvailabilityChanged(e: DomainEvent<"ListingAvailabilityChanged">): Promise<number> {
  const { listingId, fromAvailability, toAvailability } = e.payload;
  if (fromAvailability !== "out_of_stock" || toAvailability === "out_of_stock") return 0; // only a real out_of_stock -> orderable transition
  return fanOut("back_in_stock", e, listingId, { from: null, to: null }, toAvailability);
}

/**
 * The listing is live again after being unpublished. This says nothing about stock (the seller may have taken it down for any
 * reason), so it is its own alert kind. (A first publication has no savers, so this only ever reaches people who saved it earlier.)
 */
export async function onListingPublished(e: DomainEvent<"ListingPublished">): Promise<number> {
  return fanOut("listing_relisted", e, e.payload.listingId, { from: null, to: null });
}
