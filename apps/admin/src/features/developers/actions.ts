"use server";
import { audited } from "@cnote/admin";
import { revokeApiKeyAsStaff } from "@cnote/developer";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

export async function revokeApiKeyAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const id = z.uuid().parse(fd.get("id"));
    const ctx = await actionContext();
    await audited(ctx, "api_keys.revoke", "api_key.revoke", { type: "api_key", id }, () => revokeApiKeyAsStaff(id, ctx.staff.id));
  });
  if (r.ok) revalidatePath("/developers");
  return r;
}
