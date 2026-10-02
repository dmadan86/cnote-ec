import { Alert } from "@cnote/ui";
import { ResetPasswordForm } from "@cnote/next-kit/client";
import { one } from "@/lib/util";

export const metadata = { title: "Reset password", referrer: "no-referrer" as const };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const token = one((await searchParams).token);
  if (!token) return <Alert tone="danger">This reset link is invalid or has expired.</Alert>;
  return <ResetPasswordForm token={token} allowSignUp={false} paths={{ signIn: "/signin", forgot: "/forgot-password" }} />;
}
