import { z } from "zod";

export const TRIGGERS = [
  "pdp_best_price", "pdp_contact_seller", "request_quote", "compare_limit", "wishlist", "catalogue_download",
  "product_views", "return_visit", "exit_intent",
] as const;
export const UNLOCKS = ["enquiry", "seller_contact", "quotes", "save", "catalogue"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export type Unlock = (typeof UNLOCKS)[number];

const s = (max: number) => z.string().trim().max(max).optional();
export const attributionSchema = z
  .object({
    utm_source: s(100), utm_medium: s(100), utm_campaign: s(150), utm_term: s(150), utm_content: s(150),
    referrer: s(300), landingPath: s(300), device: z.enum(["mobile", "tablet", "desktop"]).optional(),
  })
  .default({});
export type Attribution = z.infer<typeof attributionSchema>;

export const startCaptureSchema = z.object({
  visitorId: z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/),
  trigger: z.enum(TRIGGERS),
  unlock: z.enum(UNLOCKS),
  listingId: z.string().uuid().nullish(),
  attribution: attributionSchema,
  followUpConsent: z.boolean().default(false),
});
export type StartCaptureInput = z.input<typeof startCaptureSchema>;

export const unlockDetailsSchema = z
  .object({
    quantity: z.number().int().positive().max(2_000_000_000).nullish(),
    quantityUnit: z.string().trim().max(20).nullish(),
    message: z.string().trim().max(1000).nullish(),
    deliveryPincode: z.string().trim().regex(/^[1-9]\d{5}$/).nullish(),
    deliveryCity: z.string().trim().max(80).nullish(),
  })
  .default({});
export type UnlockDetails = z.input<typeof unlockDetailsSchema>;

/** What completeUnlock granted. Seller phone numbers are never part of any result (ADR-002). */
export type UnlockResult =
  | { kind: "enquiry"; enquiryId: string; next: string }
  | { kind: "seller_contact"; enquiryId: string; next: string; contactRule: "in_app_after_match" }
  | { kind: "quotes"; next: string }
  | { kind: "none"; next: string };
