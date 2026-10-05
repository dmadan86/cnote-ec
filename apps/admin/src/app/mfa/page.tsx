import { getMfaEnrollmentInfo, getMfaPending } from "@cnote/next-kit";
import { MfaChallengeForm, MfaEnrollForm, PasskeyEnrollPanel } from "@cnote/next-kit/client";
import { redirect } from "next/navigation";

export const metadata = { title: "Two-factor authentication" };

/** Second step of admin sign-in: enter a code (enrolled) or set up an authenticator (first sign-in). No session exists until this passes. */
export default async function MfaPage() {
  const pending = await getMfaPending();
  if (!pending) redirect("/signin");
  if (pending.mode === "passkey_enroll") return <PasskeyEnrollPanel />;
  if (pending.mode === "enroll") {
    const info = await getMfaEnrollmentInfo();
    if (!info) redirect("/signin");
    if (info.done) return <MfaEnrollForm manualKey="" otpauthUri="" done />;
    return <MfaEnrollForm manualKey={info.manualKey} otpauthUri={info.otpauthUri} />;
  }
  return <MfaChallengeForm passkey={pending.hasPasskey} passkeyRequired={pending.passkeyRequired} />;
}
