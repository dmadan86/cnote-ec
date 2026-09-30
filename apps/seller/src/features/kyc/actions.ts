"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { identity } from "@/lib/services";

export async function startKycAction(): Promise<ActionResult<{ sessionId: string }>> {
  const session = await requireSeller("/verification");
  const r = await run(async () => ({ sessionId: (await identity.startKyc({ personId: session.personId, businessId: session.business.id })).id }));
  if (r.ok) revalidatePath("/verification");
  return r;
}

/** Starts the provider's hosted video/liveness flow: full-page redirect (no iframe/SDK on our pages). */
export async function beginVideoKycAction(sessionId: string): Promise<ActionResult<{ status: string }>> {
  const session = await requireSeller("/verification");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "https";
  const r = await run(async () => {
    const out = await identity.beginVideoKyc({ personId: session.personId, businessId: session.business.id }, sessionId, { returnUrl: host ? `${proto}://${host}/verification` : undefined });
    logEvent("seller.kyc_video_started", { businessId: session.business.id, status: out.session.status });
    return { url: out.url, status: out.session.status };
  });
  if (r.ok && r.data.url) redirect(r.data.url);
  revalidatePath("/verification");
  revalidatePath("/dashboard");
  return r.ok ? { ok: true, data: { status: r.data.status } } : r;
}
