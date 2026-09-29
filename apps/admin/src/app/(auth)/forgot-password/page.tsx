import { ForgotPasswordForm } from "@cnote/next-kit/client";

export const metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm allowSignUp={false} paths={{ signIn: "/signin", forgot: "/forgot-password" }} />;
}
