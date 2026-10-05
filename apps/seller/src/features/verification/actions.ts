"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getTranslations } from "next-intl/server";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { checkGstin, normalizeGstin, UDYAM_PATTERN } from "@/lib/gstin";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { identity } from "@/lib/services";

export type RegistryResult = ActionResult<{ decision: "passed" | "review" | "failed" | "unavailable"; reason?: string; status?: string }>;

export type GstResult = ActionResult<{ passed: boolean; tier: number; reason?: string }>;

/** ADR-003 T1: GSTIN checksum here, then GSTN provider lookup in identity. Udyam optional. */
export async function verifyGstinAction(_prev: GstResult | null, fd: FormData): Promise<GstResult> {
  const mode = str(fd, "mode") === "onboarding" ? "onboarding" : "portal";
  const session = await requireSeller(mode === "onboarding" ? "/onboarding" : "/verification");
  const t = await getTranslations("verification.gst");
  const result = await run(async () => {
    const parsed = z
      .object({
        gstin: z.string().refine((v) => checkGstin(v).ok, t("errGstin")),
        udyam: z.string().refine((v) => v === "" || UDYAM_PATTERN.test(v), t("errUdyam")),
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

const CIN = /^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;

/** ADR-003 T1 supplementary evidence: Udyam registration check against the registry (owner only). */
export async function verifyUdyamAction(_prev: RegistryResult | null, fd: FormData): Promise<RegistryResult> {
  const session = await requireSeller("/verification");
  const t = await getTranslations("verification.registry");
  const result = await run(async () => {
    const number = z.string().refine((v) => UDYAM_PATTERN.test(v), t("errUdyam")).parse(str(fd, "number").toUpperCase().replace(/\s+/g, ""));
    const o = await identity.verifyUdyam(session.business.id, { number });
    logEvent("seller.udyam_verification", { businessId: session.business.id, decision: o.decision });
    return { decision: o.decision, reason: o.reasons[0] };
  });
  if (result.ok) { revalidatePath("/verification"); revalidatePath("/dashboard"); }
  return result;
}

/** ADR-003 T1 supplementary evidence: MCA company record (CIN) check. */
export async function verifyMcaAction(_prev: RegistryResult | null, fd: FormData): Promise<RegistryResult> {
  const session = await requireSeller("/verification");
  const t = await getTranslations("verification.registry");
  const result = await run(async () => {
    const number = z.string().refine((v) => CIN.test(v), t("errCin")).parse(str(fd, "number").toUpperCase().replace(/\s+/g, ""));
    const o = await identity.verifyMca(session.business.id, { number });
    logEvent("seller.mca_verification", { businessId: session.business.id, decision: o.decision });
    return { decision: o.decision, reason: o.reasons[0], status: (o.record as { status?: string } | null)?.status };
  });
  if (result.ok) { revalidatePath("/verification"); revalidatePath("/dashboard"); }
  return result;
}
