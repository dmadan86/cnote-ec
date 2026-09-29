"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { str } from "@/lib/form-data";
import { logEvent } from "@/lib/metrics";
import { run } from "@/lib/run";
import { identity } from "@/lib/services";

export interface CheckView {
  id: string;
  result: "pass" | "warn" | "fail" | "skip";
  detail: string;
}
export interface CompanyResult {
  /** "saved" when only details were saved (no GSTIN entered) */
  decision: "saved" | "passed" | "review" | "failed" | "unavailable";
  checks: CheckView[];
  reasons: string[];
}
export type CompanyFormResult = ActionResult<CompanyResult>;

function readInput(fd: FormData) {
  const stateCode = str(fd, "stateCode");
  return {
    legalName: str(fd, "legalName"),
    tradeName: str(fd, "tradeName"),
    companyType: str(fd, "companyType") as identity.CompanyType,
    cin: str(fd, "cin"),
    pan: str(fd, "pan"),
    gstin: str(fd, "gstin"),
    website: str(fd, "website"),
    registeredAddress: {
      line1: str(fd, "line1"), line2: str(fd, "line2"), city: str(fd, "city"),
      state: identity.GST_STATES[stateCode] ?? "", stateCode, pincode: str(fd, "pincode"),
    },
  };
}

/** Saves company details and, when a GSTIN is given, verifies it and reports each check (ADR-003). */
export async function saveCompanyAction(_prev: CompanyFormResult | null, fd: FormData): Promise<CompanyFormResult> {
  const mode = str(fd, "mode") === "onboarding" ? "onboarding" : "portal";
  const session = await requireSeller(mode === "onboarding" ? "/onboarding" : "/settings/company");
  const result = await run<CompanyResult>(async () => {
    const input = readInput(fd);
    const actor = { personId: session.personId, businessId: session.business.id };
    await identity.updateCompanyProfile(actor, input);
    if (!input.gstin) return { decision: "saved", checks: [], reasons: [] };
    const o = await identity.verifyCompanyGst(session.business.id, { gstin: input.gstin });
    logEvent("seller.gst_verification", { businessId: session.business.id, decision: o.decision, score: o.score });
    return { decision: o.decision, checks: o.checks.map((c) => ({ id: c.id, result: c.result, detail: c.detail })), reasons: o.reasons };
  });
  if (result.ok) {
    revalidatePath("/verification");
    revalidatePath("/settings/company");
    revalidatePath("/dashboard");
    if (mode === "onboarding" && result.data.decision === "passed") redirect("/onboarding");
  }
  return result;
}
