import "server-only";
import { cookies } from "next/headers";

/** Small onboarding-progress cookies. Not security relevant; server state (business, listings) stays the source of truth. */
export const ONB = {
  startedAt: "seller_onb_t0",
  firstListing: "seller_onb_t1",
  done: "seller_onb_done",
  skipGst: "seller_onb_skip_gst",
  skipListing: "seller_onb_skip_listing",
  /** Set by proxy.ts from ?ref=CODE. */
  referral: "seller_ref",
} as const;

const YEAR = 60 * 60 * 24 * 365;

export async function readOnb(name: string): Promise<string | undefined> {
  return (await cookies()).get(name)?.value;
}
export async function writeOnb(name: string, value: string): Promise<void> {
  (await cookies()).set(name, value, { path: "/", maxAge: YEAR, sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" });
}
export async function clearOnb(name: string): Promise<void> {
  (await cookies()).delete(name);
}
