import type { Metadata } from "next";
import { SignUpForm } from "@cnote/next-kit/client";

export const metadata: Metadata = { title: "Create your seller account" };

export default async function SignUpPage({ searchParams }: PageProps<"/signup">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/onboarding";
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Start selling, free</h1>
        <p className="mt-1 text-sm text-muted">Create your account, then list your first product in about five minutes. No GST needed to start.</p>
      </div>
      <SignUpForm next={next} googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID)} />
    </div>
  );
}
