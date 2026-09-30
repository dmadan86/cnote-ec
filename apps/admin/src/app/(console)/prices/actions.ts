"use server";
import { audited } from "@cnote/admin";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { republishCell, runBenchmarks, setK, unpublishCell } from "@cnote/prices";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

const done = (r: ActionResult) => { if (r.ok) revalidatePath("/prices"); return r; };

const kSchema = z.object({ k: z.coerce.number().int("k must be a whole number").min(3, "k must be at least 3").max(100, "k must be at most 100"), reason: z.string().trim().min(3, "Give a reason (min 3 characters)").max(300) });

/** Changes the k-anonymity threshold used from the next run. prices.manage, audited with the reason. */
export async function setKAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return done(await runAction(async () => {
    const input = kSchema.parse({ k: fd.get("k"), reason: fd.get("reason") });
    const ctx = await actionContext();
    await audited(ctx, "prices.manage", "prices.k.set", { type: "price_config", id: "k" }, () => setK(input.k, ctx.staff.id), { k: input.k, reason: input.reason });
  }));
}

const cell = z.object({ cellId: z.uuid(), reason: z.string().trim().min(3, "Give a reason (min 3 characters)").max(300) });

/** Takes one benchmark cell down immediately; later runs refresh but never re-publish it. */
export async function unpublishCellAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return done(await runAction(async () => {
    const input = cell.parse({ cellId: fd.get("cellId"), reason: fd.get("reason") });
    const ctx = await actionContext();
    await audited(ctx, "prices.manage", "prices.cell.unpublish", { type: "price_benchmark", id: input.cellId }, () => unpublishCell(input.cellId, ctx.staff.id, input.reason), { reason: input.reason });
  }));
}

export async function republishCellAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  return done(await runAction(async () => {
    const input = z.object({ cellId: z.uuid() }).parse({ cellId: fd.get("cellId") });
    const ctx = await actionContext();
    await audited(ctx, "prices.manage", "prices.cell.republish", { type: "price_benchmark", id: input.cellId }, () => republishCell(input.cellId));
  }));
}

/** Runs the aggregation now (same code as the nightly job). */
export async function runNowAction(): Promise<ActionResult> {
  return done(await runAction(async () => {
    const ctx = await actionContext();
    await audited(ctx, "prices.manage", "prices.run", { type: "price_benchmark_run", id: "manual" }, async () => { await runBenchmarks({ trigger: "manual" }); });
  }));
}
