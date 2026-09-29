import type { Metadata } from "next";
import { ForgotPasswordForm } from "@cnote/next-kit/client";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}
