// The rate card: ALL heuristic prices are data (stored in `freight_rate_cards`, edited by staff via audited()), never code.
// DEFAULT_RATE_CARD is the seed/fallback. Money is integer paise; thresholds are kilograms.
import { z } from "zod";
import { ZONES, type Zone } from "./types";

const paise = z.number().int().min(0).max(100_000_000_00);
const zoned = <T extends z.ZodType>(t: T) => z.object(Object.fromEntries(ZONES.map((z_) => [z_, t])) as Record<Zone, T>);
const days = z.object({ min: z.number().int().min(0).max(60), max: z.number().int().min(0).max(90) }).refine((d) => d.min <= d.max, "min must be <= max");

export const rateCardSchema = z.object({
  /** unit weight assumed when the listing has none */
  defaultUnitWeightGrams: z.number().int().min(1).max(1_000_000),
  /** at or below this chargeable weight a shipment goes by courier (parcel) */
  parcelMaxKg: z.number().min(1).max(200),
  /** above parcel and up to this weight: part-truck / surface cargo (LTL); beyond: full truck */
  ltlMaxKg: z.number().min(50).max(50_000),
  /** volumetric divisors, cm3 per kg: L x W x H (cm) / divisor */
  parcelVolumetricDivisor: z.number().int().min(1000).max(10_000),
  ltlVolumetricDivisor: z.number().int().min(1000).max(10_000),
  fuelSurchargeBps: z.number().int().min(0).max(5000),
  gstBps: z.number().int().min(0).max(3000),
  /** low = mid x (1 + lowSpreadBps/10000); high = mid x (1 + highSpreadBps/10000) */
  lowSpreadBps: z.number().int().min(-9000).max(0),
  highSpreadBps: z.number().int().min(0).max(20_000),
  parcel: z.object({
    /** ascending cumulative slabs: chargeable weight rounds up to the first slab with upToKg >= weight */
    slabs: z.array(z.object({ upToKg: z.number().positive().max(200), rates: zoned(paise) })).min(1).max(12),
    transitDays: zoned(days),
  }),
  ltl: z.object({
    minChargeableKg: z.number().min(1).max(1000),
    perKgPaise: zoned(paise),
    minChargePaise: zoned(paise),
    transitDays: zoned(days),
  }),
  ftl: z.object({
    vehicles: z.array(z.object({ name: z.string().min(1).max(60), capacityKg: z.number().min(100).max(60_000), rates: zoned(paise) })).min(1).max(10),
    transitDays: zoned(days),
  }),
});
export type RateCard = z.infer<typeof rateCardSchema>;

const z6 = <T>(local: T, intra: T, metro: T, regional: T, national: T, special: T): Record<Zone, T> => ({ local, intra_state: intra, metro, regional, national, special });
const rupees = (...r: number[]): number[] => r.map((x) => Math.round(x * 100));
const slab = (upToKg: number, ...r: number[]) => {
  const [a, b, c, d, e, f] = rupees(...r) as [number, number, number, number, number, number];
  return { upToKg, rates: z6(a, b, c, d, e, f) };
};
const t = (a: number, b: number) => ({ min: a, max: b });

/** Indicative 2026 Indian road/surface rates. Deliberately round, public-benchmark-style numbers; the seller quotes the real freight. */
export const DEFAULT_RATE_CARD: RateCard = {
  defaultUnitWeightGrams: 1000,
  parcelMaxKg: 30,
  ltlMaxKg: 3000,
  parcelVolumetricDivisor: 5000,
  ltlVolumetricDivisor: 4000,
  fuelSurchargeBps: 1200,
  gstBps: 1800,
  lowSpreadBps: -1500,
  highSpreadBps: 2500,
  parcel: {
    //            local intra metro regional national special
    slabs: [
      slab(0.5, 35, 45, 55, 60, 75, 110),
      slab(1, 45, 60, 75, 85, 105, 160),
      slab(2, 60, 85, 110, 125, 160, 260),
      slab(5, 90, 130, 170, 200, 270, 480),
      slab(10, 140, 210, 280, 340, 460, 850),
      slab(30, 300, 450, 600, 720, 980, 1900),
    ],
    transitDays: z6(t(1, 2), t(2, 3), t(2, 4), t(3, 5), t(4, 7), t(6, 10)),
  },
  ltl: {
    minChargeableKg: 30,
    perKgPaise: z6(...(rupees(3, 4.5, 6, 7, 9, 15) as [number, number, number, number, number, number])),
    minChargePaise: z6(...(rupees(250, 350, 450, 500, 650, 1200) as [number, number, number, number, number, number])),
    transitDays: z6(t(1, 2), t(2, 4), t(3, 5), t(4, 6), t(5, 8), t(8, 14)),
  },
  ftl: {
    vehicles: [
      { name: "Mini truck (1 t)", capacityKg: 1000, rates: z6(...(rupees(2500, 6500, 16000, 12000, 22000, 36000) as [number, number, number, number, number, number])) },
      { name: "LCV (2.5 t)", capacityKg: 2500, rates: z6(...(rupees(3500, 9000, 22000, 16500, 30000, 50000) as [number, number, number, number, number, number])) },
      { name: "ICV (7.5 t)", capacityKg: 7500, rates: z6(...(rupees(5500, 13000, 31000, 23000, 42000, 70000) as [number, number, number, number, number, number])) },
      { name: "Truck (10 t)", capacityKg: 10_000, rates: z6(...(rupees(6500, 15000, 36000, 27000, 48000, 80000) as [number, number, number, number, number, number])) },
      { name: "Truck (20 t)", capacityKg: 20_000, rates: z6(...(rupees(9000, 21000, 50000, 38000, 68000, 112000) as [number, number, number, number, number, number])) },
    ],
    transitDays: z6(t(1, 1), t(1, 2), t(2, 3), t(2, 4), t(3, 6), t(5, 9)),
  },
};
