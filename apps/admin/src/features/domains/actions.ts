"use server";
import { audited, requirePrivilege } from "@cnote/admin";
import { forceRecheck, removeDomainById } from "@cnote/domains";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const schema = z.object({ id: z.uuid(), hostname: z.string().max(253).optional() });

/** Restart verification for a domain now. Audited under storefronts.review. */
export async function recheckDomainAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ id: fd.get("id"), hostname: fd.get("hostname") ?? undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "storefronts.review");
    await audited(ctx, "storefronts.review", "domain.recheck", { type: "storefront_domain", id: input.id }, () => forceRecheck(input.id), { hostname: input.hostname });
  });
  if (result.ok) revalidatePath("/domains");
  return result;
}

/** Remove a seller's domain (e.g. abuse, hijack claim). Deletes the edge hostname and the record. Audited. */
export async function removeDomainAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const result = await runAction(async () => {
    const input = schema.parse({ id: fd.get("id"), hostname: fd.get("hostname") ?? undefined });
    const ctx = await actionContext();
    requirePrivilege(ctx.staff, "storefronts.review");
    await audited(ctx, "storefronts.review", "domain.remove", { type: "storefront_domain", id: input.id }, () => removeDomainById(input.id), { hostname: input.hostname });
  });
  if (result.ok) revalidatePath("/domains");
  return result;
}
