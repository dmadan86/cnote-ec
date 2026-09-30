"use server";
// Buyer-side benchmark lookup for the RFQ form (ADR-022). Public-safe aggregates only; requires a signed-in business
// (the RFQ page does too) and is rate limited so it cannot be used to scrape the benchmark table.
import { rateLimit } from "@cnote/core";
import { requireBusiness } from "@cnote/next-kit";
import { getPublicBenchmark, type PublicBenchmark } from "@cnote/prices";

export interface HintQuery { categorySlug: string; quantity: number | null; unit: string | null; pincode: string | null }

const clean = (s: string | null, max: number) => (typeof s === "string" && s.trim() ? s.trim().slice(0, max) : null);

export async function lookupBenchmarkAction(input: HintQuery): Promise<PublicBenchmark | null> {
  const s = await requireBusiness("/rfq/new");
  const slug = clean(input?.categorySlug, 80);
  if (!slug) return null;
  try {
    if (!(await rateLimit(`prices:hint:${s.business.id}`, 60, 60))) return null;
    const q = Number(input.quantity);
    return await getPublicBenchmark({
      categorySlug: slug, quantity: Number.isFinite(q) && q > 0 ? q : null, unit: clean(input.unit, 20), pincode: clean(input.pincode, 6),
    });
  } catch {
    return null; // a hint must never break the form
  }
}
