"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { checkGstin, normalizeGstin, UDYAM_PATTERN } from "@/lib/gstin";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { identity } from "@/lib/services";

export type GstResult = ActionResult<{ passed: boolean; tier: number; reason?: string }>;

/** ADR-003 T1: GSTIN checksum here, then GSTN provider lookup in identity. Udyam optional. */
export async function verifyGstinAction(_prev: GstResult | null, fd: FormData): Promise<GstResult> {
  const mode = str(fd, "mode") === "onboarding" ? "onboarding" : "portal";
  const session = await requireSeller(mode === "onboarding" ? "/onboarding" : "/verification");
  const result = await run(async () => {
    const parsed = z
      .object({
        gstin: z.string().refine((v) => checkGstin(v).ok, "This GSTIN does not look right. Check it and try again."),
        udyam: z.string().refine((v) => v === "" || UDYAM_PATTERN.test(v), "Udyam looks like UDYAM-KA-03-0012345."),
      })
      .parse({ gstin: normalizeGstin(str(fd, "gstin")), udyam: str(fd, "udyam").toUpperCase().replace(/\s+/g, "") });
    const res = await identity.verifyGstin(session.business.id, parsed.gstin, parsed.udyam || undefined);
    logEvent("seller.gst_verification", { businessId: session.business.id, passed: res.passed, tier: res.tier });
    return res;
  });
  if (result.ok && result.data.passed) {
    revalidatePath("/verification");
    revalidatePath("/dashboard");
    if (mode === "onboarding") redirect("/onboarding");
  }
  return result;
}
