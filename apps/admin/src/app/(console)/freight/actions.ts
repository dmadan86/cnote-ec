"use server";
import { audited } from "@cnote/admin";
import { activateRateCard, parseRateCardJson, resetRateCardToDefault, saveRateCard } from "@cnote/logistics";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const done = (r: ActionResult) => { if (r.ok) revalidatePath("/freight"); return r; };
const reason = z.string().trim().min(3, "Give a reason (min 3 characters)").max(300);

/** Saves the edited rate card as the next version and activates it. logistics.manage, audited with the reason. */
export async function saveRateCardAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return done(await runAction(async () => {
    const input = z.object({ card: z.string().min(2).max(200_000), reason }).parse({ card: fd.get("card"), reason: fd.get("reason") });
    const card = parseRateCardJson(input.card);
    const ctx = await actionContext();
    await audited(ctx, "logistics.manage", "logistics.rate_card.save", { type: "freight_rate_card", id: "new" }, () => saveRateCard(card, ctx.staff.id, input.reason), { reason: input.reason });
  }));
}

/** Rollback / forward to an existing version. */
export async function activateRateCardAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return done(await runAction(async () => {
    const input = z.object({ version: z.coerce.number().int().min(1), reason }).parse({ version: fd.get("version"), reason: fd.get("reason") });
    const ctx = await actionContext();
    await audited(ctx, "logistics.manage", "logistics.rate_card.activate", { type: "freight_rate_card", id: String(input.version) }, () => activateRateCard(input.version), { version: input.version, reason: input.reason });
  }));
}

/** Back to the built-in default card (deactivates every stored version). */
export async function resetRateCardAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return done(await runAction(async () => {
    const input = z.object({ reason }).parse({ reason: fd.get("reason") });
    const ctx = await actionContext();
    await audited(ctx, "logistics.manage", "logistics.rate_card.reset", { type: "freight_rate_card", id: "default" }, () => resetRateCardToDefault(), { reason: input.reason });
  }));
}
