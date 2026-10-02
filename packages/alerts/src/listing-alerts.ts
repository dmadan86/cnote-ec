// Price-drop and back-in-stock alerts on wishlist items, triggered by catalogue domain events (ListingPriceChanged, and
// ListingPublished which also fires when an unpublished listing goes live again). Only people who opted in to that alert type are
// touched; delivery honours the notification preferences. Handlers are idempotent (at-least-once delivery): every (event, person)
// pair is claimed in the AlertDispatch ledger inside the transaction that emits the alert.
import { getPublicListingsByIds } from "@cnote/catalogue";
import { emit, type DomainEvent } from "@cnote/core";
import { prisma } from "@cnote/db";
import { listSaversOfListing } from "@cnote/wishlist";
import { claimDispatch, filterOptedIn } from "./settings";

type Kind = "price_drop" | "back_in_stock";

async function fanOut(kind: Kind, event: { id: number }, listingId: string, prices: { from: number | null; to: number | null }): Promise<number> {
  const savers = await listSaversOfListing(listingId);
  if (!savers.length) return 0;
  const opted = await filterOptedIn(savers.map((s) => s.personId), kind);
  if (!opted.size) return 0;
  const listing = (await getPublicListingsByIds([listingId]).catch(() => []))[0];
  if (!listing) return 0; // not publicly visible (any more): nothing to point the buyer at
  let sent = 0;
  for (const s of savers) {
    if (!opted.has(s.personId)) continue;
    const done = await prisma.$transaction(async (tx) => {
      if (!(await claimDispatch(tx, s.personId, `${kind}:${event.id}:${s.personId}`, kind))) return false;
      await emit(tx, "BuyerAlertTriggered", { type: "Listing", id: listingId }, {
        personId: s.personId, alertType: kind, subjectId: listingId, label: listing.title, count: 1, fromPricePaise: prices.from, toPricePaise: prices.to, href: `/p/${listingId}`,
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

/** The listing is live again. (A first publication has no savers, so this only ever reaches people who saved it earlier.) */
export async function onListingPublished(e: DomainEvent<"ListingPublished">): Promise<number> {
  return fanOut("back_in_stock", e, e.payload.listingId, { from: null, to: null });
}
