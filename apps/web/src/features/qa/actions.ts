"use server";
// Buyer-side "ask a question" action. Re-checks the session (server actions are reachable by direct POST), applies a
// per-IP limit on top of the per-person limit inside @cnote/reviews, and never publishes anything: the question is
// private to the asker and the seller until the seller's answer is approved.
import { DomainError, rateLimit } from "@cnote/core";
import { type ActionResult, currentSession } from "@cnote/next-kit";
import { askQuestion } from "@cnote/reviews";
import { clientIp } from "@cnote/security/client-ip";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { runLocalized } from "@/i18n/errors";
import { getRequestLocale } from "@/lib/request-locale";

export interface AskResult {
  status: "pending" | "approved" | "rejected";
  piiStripped: boolean;
}

const IP_QUESTIONS_PER_HOUR = 20;

export async function askQuestionAction(_prev: ActionResult<AskResult> | null, f: FormData): Promise<ActionResult<AskResult>> {
  const session = await currentSession();
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "qa" });
  if (!session) return { ok: false, error: t("signIn") };
  const id = f.get("listingId");
  const body = f.get("body");
  return runLocalized(async () => {
    const listingId = z.uuid().parse(typeof id === "string" ? id : "");
    const ip = clientIp(await headers()) ?? "unknown";
    if (!(await rateLimit(`qa:ask:ip:${ip}`, IP_QUESTIONS_PER_HOUR, 3_600))) throw new DomainError("rate_limited", "Too many questions from this network. Please try again later.");
    const q = await askQuestion({ personId: session.personId, businessId: session.business?.id ?? null }, listingId, { body: typeof body === "string" ? body : "", language: session.preferredLanguage });
    return { status: q.status, piiStripped: q.piiStripped };
  });
}
