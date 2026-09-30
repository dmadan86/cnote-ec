import { z } from "zod";

const optStr = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));

export const enquiryInputSchema = z.object({
  title: z.string().trim().min(5, "Give your requirement a short title (5+ characters)").max(140),
  requirement: z.string().trim().min(10, "Describe what you need (10+ characters)").max(4000),
  categorySlug: optStr(100),
  quantity: z.number().int().positive().max(2_000_000_000).nullish().transform((v) => v ?? null),
  quantityUnit: optStr(20),
  targetPricePaise: z.number().int().positive().max(10_000_000_000_00).nullish().transform((v) => v ?? null),
  deliveryCity: optStr(80),
  deliveryPincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, "Enter a 6-digit pincode")
    .nullish()
    .transform((v) => v ?? null),
  neededBy: z
    .string()
    .nullish()
    .refine((v) => !v || !Number.isNaN(Date.parse(v)), "Enter a valid date")
    .transform((v) => v ?? null),
  language: z.string().trim().max(8).default("en"),
  buyerPicks: z.boolean().default(false),
  preferredListingId: z.string().uuid().nullish().transform((v) => v ?? null),
  preferredSellerId: z.string().uuid().nullish().transform((v) => v ?? null),
});
export type ParsedEnquiryInput = z.output<typeof enquiryInputSchema>;

export const quoteSchema = z.object({
  pricePaise: z.number().int().positive().max(10_000_000_000_00),
  quantity: z.number().int().positive().max(2_000_000_000),
  unit: z.string().trim().min(1).max(20),
  leadTimeDays: z.number().int().min(0).max(730).nullish().transform((v) => v ?? null),
  notes: z.string().trim().max(2000).nullish().transform((v) => v || null),
  validUntil: z
    .string()
    .nullish()
    .refine((v) => !v || !Number.isNaN(Date.parse(v)), "Enter a valid date")
    .transform((v) => v ?? null),
});

export const messageSchema = z.string().trim().min(1, "Message is empty").max(4000, "Message is too long (max 4,000 characters)");
