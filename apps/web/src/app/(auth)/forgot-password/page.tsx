import { ForgotPasswordForm } from "@cnote/next-kit/client";
import { AuthHeading } from "@/features/identity/auth-page";

export const metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <AuthHeading title="Forgot your password?" subtitle="Enter your email and we'll send you a reset link." />
      <ForgotPasswordForm />
    </>
  );
}
