import { getMfaPending } from "@cnote/next-kit";
import { MfaChallengeForm } from "@cnote/next-kit/client";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.mfa");
  return { title: t("meta") };
}

/** Second step of sign-in for sellers who turned on two-factor. No session exists until a code is verified. */
export default async function MfaPage() {
  const pending = await getMfaPending();
  if (!pending || pending.mode !== "verify") redirect("/signin");
  return <MfaChallengeForm />;
}
