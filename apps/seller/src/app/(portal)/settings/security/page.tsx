import type { Metadata } from "next";
import { mfaStatus } from "@cnote/identity";
import { MfaSettings } from "@cnote/next-kit/client";
import { PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";

export const metadata: Metadata = { title: "Security" };

/** Optional two-factor sign-in for seller accounts (TOTP authenticator app). */
export default async function SecurityPage() {
  const session = await requireSeller("/settings/security");
  const status = await mfaStatus(session.personId);
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Security" description="Add a second step to sign-in so your leads and credits stay yours." />
      <MfaSettings enabled={status.enabled} recoveryCodesLeft={status.recoveryCodesLeft} />
    </div>
  );
}
