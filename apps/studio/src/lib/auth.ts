import "server-only";
import { DomainError } from "@cnote/core";
import { currentSession, requireSession, type SessionWithBusiness } from "@cnote/next-kit";
import { cache } from "react";

/** Session for a person whose business is a seller; `null` business/seller is handled by the layout (points to the seller app). */
export const requireSellerSession = cache(async (returnTo = "/") => requireSession(returnTo, { signInPath: "/signin" }));

export async function actionSeller(): Promise<{ personId: string; businessId: string }> {
  const s = await currentSession();
  if (!s) throw new DomainError("unauthenticated", "Your session expired. Please sign in again.");
  if (!s.business?.isSeller) throw new DomainError("forbidden", "Studio is for seller accounts.");
  return { personId: s.personId, businessId: s.business.id };
}

export type SellerSession = SessionWithBusiness;
