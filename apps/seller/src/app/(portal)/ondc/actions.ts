"use server";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { acceptOrder, connectSeller, disconnectSeller, publishCatalog, rejectOrder, setListingOptIn, TERMS_VERSION } from "@/lib/ondc";
import { z } from "zod";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";

export type OndcResult = ActionResult<null>;

/** Connect (needs the terms box ticked) or disconnect the ONDC channel. ADR-017. */
export async function channelAction(_prev: OndcResult | null, fd: FormData): Promise<OndcResult> {
  const session = await requireSeller("/ondc");
  const t = await getTranslations("ondc");
  return run(async () => {
    const actor = actorOf(session);
    if (fd.get("intent") === "disconnect") await disconnectSeller(actor);
    else {
      if (fd.get("terms") !== "on") throw new Error(t("acceptTerms"));
      await connectSeller(actor, { acceptTermsVersion: String(fd.get("termsVersion") ?? TERMS_VERSION) });
    }
    await publishCatalog(actor.businessId);
    revalidatePath("/ondc");
    return null;
  });
}

/** Opt one listing in or out of ONDC. */
export async function listingOptInAction(_prev: OndcResult | null, fd: FormData): Promise<OndcResult> {
  const session = await requireSeller("/ondc");
  return run(async () => {
    const { listingId, optIn } = z.object({ listingId: z.uuid(), optIn: z.enum(["1", "0"]) }).parse({ listingId: fd.get("listingId"), optIn: fd.get("optIn") });
    await setListingOptIn(actorOf(session), listingId, optIn === "1");
    await publishCatalog(session.business.id);
    revalidatePath("/ondc");
    return null;
  });
}

/** Accept or reject an incoming ONDC order; the buyer app is notified by a signed callback. */
export async function orderDecisionAction(_prev: OndcResult | null, fd: FormData): Promise<OndcResult> {
  const session = await requireSeller("/ondc/orders");
  return run(async () => {
    const { orderId, intent } = z.object({ orderId: z.uuid(), intent: z.enum(["accept", "reject"]) }).parse({ orderId: fd.get("orderId"), intent: fd.get("intent") });
    if (intent === "accept") await acceptOrder(session.business.id, orderId);
    else await rejectOrder(session.business.id, orderId);
    revalidatePath("/ondc/orders");
    return null;
  });
}
