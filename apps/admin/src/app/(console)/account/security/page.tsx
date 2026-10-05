import { mfaStatus, passkeysEnabled } from "@cnote/identity";
import { MfaSettings, PasskeySettings } from "@cnote/next-kit/client";
import { Alert, PageHeader } from "@cnote/ui";
import { requireStaff } from "@/lib/auth";

export const metadata = { title: "Security" };

export default async function SecurityPage({ searchParams }: PageProps<"/account/security">) {
  const { session } = await requireStaff("/account/security");
  const [status, sp] = await Promise.all([mfaStatus(session.personId), searchParams]);
  return (
    <div className="max-w-xl space-y-4">
      <PageHeader title="Security" description="Two-factor authentication protects the back office even if your password leaks." />
      {sp.setup && !status.enabled ? <Alert tone="warning">Set up two-factor authentication to continue. Back-office access requires it.</Alert> : null}
      <MfaSettings enabled={status.enabled} recoveryCodesLeft={status.recoveryCodesLeft} required />
      {passkeysEnabled("admin") && status.enabled ? <PasskeySettings /> : null}
    </div>
  );
}
