import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@cnote/next-kit/client";
import { Alert } from "@cnote/ui";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage({ searchParams }: PageProps<"/reset-password">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : "";
  if (!token) {
    return (
      <Alert tone="warning">
        This reset link is incomplete. <Link href="/forgot-password" className="font-medium underline">Ask for a new one</Link>.
      </Alert>
    );
  }
  return <ResetPasswordForm token={token} />;
}
