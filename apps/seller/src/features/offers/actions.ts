"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@cnote/next-kit";
import { cancelOffer, createOffer, type OfferInput } from "@cnote/promotions";
import { requireSeller } from "@/lib/auth";
import { str, strs } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";

export type OfferResult = ActionResult<{ status: string }>;

const rupeesToPaise = (v: string): number => Math.round(Number(v.replace(/,/g, "")) * 100);
const num = (v: string) => (v === "" ? undefined : Number(v));
/** datetime-local (IST wall clock) -> Date. The portal is India-only, so the offset is fixed (+05:30, no DST). */
const istDate = (v: string): Date | undefined => (v ? new Date(`${v}:00+05:30`) : undefined);

/**
 * Seller creates an offer. The seller never enters a "was" price: the reference is computed by the platform from price history
 * (packages/promotions). Money is entered in rupees and converted to integer paise here.
 */
export async function createOfferAction(_prev: OfferResult | null, fd: FormData): Promise<OfferResult> {
  const session = await requireSeller("/offers");
  const res = await run(async (): Promise<{ status: string }> => {
    const listingId = z.uuid("Choose a listing.").parse(str(fd, "listingId"));
    const kind = z.enum(["volume_tiers", "timed_price", "free_delivery_moq"], "Choose an offer type.").parse(str(fd, "kind"));
    const startsAt = istDate(str(fd, "startsAt"));
    const endsAt = istDate(str(fd, "endsAt"));
    let input: OfferInput;
    if (kind === "volume_tiers") {
      const qtys = strs(fd, "tierQty");
      const prices = strs(fd, "tierPrice");
      const tiers = qtys.map((q, i) => ({ minQty: Number(q), unitPricePaise: rupeesToPaise(prices[i] ?? "") })).filter((t) => t.minQty || t.unitPricePaise);
      if (tiers.length === 0) throw new z.ZodError([{ code: "custom", path: ["tiers"], message: "Add at least one price tier.", input: null }]);
      input = { kind, listingId, terms: { tiers }, startsAt, endsAt };
    } else if (kind === "timed_price") {
      if (!endsAt) throw new z.ZodError([{ code: "custom", path: ["endsAt"], message: "Choose when the offer ends.", input: null }]);
      input = { kind, listingId, terms: { unitPricePaise: rupeesToPaise(str(fd, "unitPrice")) }, startsAt, endsAt };
    } else {
      const minValue = str(fd, "minOrderValue");
      input = {
        kind, listingId, startsAt, endsAt,
        terms: { minQty: num(str(fd, "minQty")), minOrderValuePaise: minValue ? rupeesToPaise(minValue) : undefined, regions: str(fd, "regions").split(",").map((r) => r.trim()).filter(Boolean) },
      };
    }
    const o = await createOffer(session.business.id, input);
    logEvent("seller.offer_created", { businessId: session.business.id, kind, status: o.status });
    revalidatePath("/offers");
    return { status: o.status };
  });
  return res;
}

export async function cancelOfferAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const session = await requireSeller("/offers");
  const res = await run(async () => {
    await cancelOffer(z.uuid().parse(str(fd, "offerId")), session.business.id);
    revalidatePath("/offers");
  });
  return res;
}
