import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { mfaStatus } from "@cnote/identity";
import { MfaSettings } from "@cnote/next-kit/client";
import { PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.security");
  return { title: t("meta") };
}

/** Optional two-factor sign-in for seller accounts (TOTP authenticator app). */
export default async function SecurityPage() {
  const session = await requireSeller("/settings/security");
  const t = await getTranslations("settings.security");
  const status = await mfaStatus(session.personId);
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <MfaSettings enabled={status.enabled} recoveryCodesLeft={status.recoveryCodesLeft} />
    </div>
  );
}
