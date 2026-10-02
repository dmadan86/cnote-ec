import "server-only";
import type { OptionalCategory } from "@cnote/consent";
import { cookies } from "next/headers";
import { requireSellerConsent } from "@/features/consent/server";

/**
 * Small onboarding-progress cookies. Not security relevant; server state (business, listings) stays the source of truth.
 * The registry (features/consent/registry.ts) classifies each one: progress the seller caused (`done`, `skip*`, and `firstListing`,
 * "I submitted my first listing") is strictly necessary; the start-time cookie (`startedAt`, used only to time onboarding) is analytics
 * and the referral code is marketing, so those two are written only after the seller opted in (DPDP s.6, ePrivacy Art 5(3);
 * docs/design/cookie-consent.md).
 */
export const ONB = {
  startedAt: "seller_onb_t0",
  firstListing: "seller_onb_t1",
  done: "seller_onb_done",
  skipGst: "seller_onb_skip_gst",
  skipListing: "seller_onb_skip_listing",
  /** Set by proxy.ts from ?ref=CODE (and /api/consent/ref when consent comes after landing). */
  referral: "seller_ref",
} as const;

/** Cookies that need consent, and which category. Everything else in ONB is strictly necessary. */
const OPTIONAL: Readonly<Record<string, OptionalCategory>> = {
  [ONB.startedAt]: "analytics",
  [ONB.referral]: "marketing",
};

const YEAR = 60 * 60 * 24 * 365;

export async function readOnb(name: string): Promise<string | undefined> {
  return (await cookies()).get(name)?.value;
}
/** Writes an onboarding cookie; a no-op for an optional one the seller has not consented to (the flow still works without it). */
export async function writeOnb(name: string, value: string): Promise<void> {
  const store = await cookies();
  const category = OPTIONAL[name];
  if (category && !requireSellerConsent(store, category)) return;
  store.set(name, value, { path: "/", maxAge: YEAR, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
}
export async function clearOnb(name: string): Promise<void> {
  (await cookies()).delete(name);
}
