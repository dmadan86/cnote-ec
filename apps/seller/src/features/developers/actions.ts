"use server";
import { createApiKey, EXPIRY_OPTIONS, revokeApiKey, scopesFromAccess, SCOPE_GROUPS, type ExpiryOption } from "@cnote/developer";
import type { ActionResult } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";

const PATH = "/settings/developers";
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

/** Returns the secret exactly once, in this response; it is never persisted or logged. */
export async function createApiKeyAction(
  _prev: ActionResult<{ secret: string; name: string }> | null,
  fd: FormData,
): Promise<ActionResult<{ secret: string; name: string }>> {
  const s = await requireSeller(PATH);
  const access: Record<string, string> = {};
  for (const feature of Object.keys(SCOPE_GROUPS)) access[feature] = str(fd, `access_${feature}`);
  const expiry = str(fd, "expiry") as ExpiryOption;
  return run(async () => {
    const { key, secret } = await createApiKey(s.personId, {
      name: str(fd, "name"),
      scopes: scopesFromAccess(access),
      expiry: EXPIRY_OPTIONS.includes(expiry) ? expiry : "30d",
      businessId: s.business.id,
    });
    revalidatePath(PATH);
    return { secret, name: key.name };
  });
}

export async function revokeApiKeyAction(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const s = await requireSeller(PATH);
  const r = await run(() => revokeApiKey(s.personId, str(fd, "id")));
  if (r.ok) revalidatePath(PATH);
  return r;
}
