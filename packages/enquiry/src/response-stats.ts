// Public supplier responsiveness (ADR-002 trust): median first-response time and lead-accept rate over the last 90
// days, from Match rows. Shown publicly only with a real sample (>= MIN_RESPONSE_SAMPLE resolved offers); below that
// the supplier is a "New supplier" and no number is exposed. Derived from lead behaviour only, never plan or payment.
import { cachedManyTagged, cacheTags } from "@cnote/core";
import { prisma } from "@cnote/db";

export const RESPONSE_WINDOW_DAYS = 90;
export const MIN_RESPONSE_SAMPLE = 5;

export interface SupplierResponseStats {
  /** offers that reached an outcome (accepted, declined, expired, refunded) in the window */
  sample: number;
  windowDays: number;
  /** false when sample < MIN_RESPONSE_SAMPLE: callers render "New supplier" and must not show the numbers */
  sufficient: boolean;
  /** median minutes from offer to the seller's accept/decline; null when insufficient or the seller never replied */
  medianFirstResponseMinutes: number | null;
  /** accepted / resolved, 0..1; null when insufficient */
  acceptRate: number | null;
}

/** Pure shaping of the aggregate row (unit-tested). */
export function toResponseStats(row: { resolved: number; accepted: number; medianSeconds: number | null; responded: number } | undefined): SupplierResponseStats {
  const sample = row?.resolved ?? 0;
  if (!row || sample < MIN_RESPONSE_SAMPLE) {
    return { sample, windowDays: RESPONSE_WINDOW_DAYS, sufficient: false, medianFirstResponseMinutes: null, acceptRate: null };
  }
  return {
    sample,
    windowDays: RESPONSE_WINDOW_DAYS,
    sufficient: true,
    medianFirstResponseMinutes: row.responded > 0 && row.medianSeconds != null ? Math.max(1, Math.round(row.medianSeconds / 60)) : null,
    acceptRate: Math.round((row.accepted / sample) * 100) / 100,
  };
}

interface Row {
  seller_business_id: string;
  resolved: bigint;
  accepted: bigint;
  responded: bigint;
  median_seconds: number | null;
}

/** Cached per seller (10 min + SWR); lead outcomes change slowly and a stale median is harmless. */
export async function getSupplierResponseStats(sellerBusinessIds: string[]): Promise<Map<string, SupplierResponseStats>> {
  return cachedManyTagged<SupplierResponseStats>(sellerBusinessIds, {
    prefix: "enquiry:response-stats:v1",
    tags: (id) => [cacheTags.seller(id)],
    ttlSeconds: 600,
    staleSeconds: 1800,
    load: async (missing) => {
      const rows = await prisma.$queryRaw<Row[]>`
        SELECT seller_business_id::text AS seller_business_id,
               count(*) FILTER (WHERE status <> 'offered' OR respond_by < now()) AS resolved,
               count(*) FILTER (WHERE status IN ('accepted', 'refunded')) AS accepted,
               count(*) FILTER (WHERE responded_at IS NOT NULL) AS responded,
               (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (responded_at - offered_at)))
                  FILTER (WHERE responded_at IS NOT NULL))::float8 AS median_seconds
        FROM matches
        WHERE seller_business_id = ANY(${missing}::uuid[])
          AND offered_at >= now() - make_interval(days => ${RESPONSE_WINDOW_DAYS}::int)
        GROUP BY seller_business_id`;
      const by = new Map(rows.map((r) => [r.seller_business_id, r]));
      return new Map(
        missing.map((id) => {
          const r = by.get(id);
          return [id, toResponseStats(r && { resolved: Number(r.resolved), accepted: Number(r.accepted), responded: Number(r.responded), medianSeconds: r.median_seconds })];
        }),
      );
    },
  });
}
