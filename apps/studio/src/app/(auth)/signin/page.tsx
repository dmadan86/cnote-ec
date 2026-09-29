import type { Metadata } from "next";
import { SignInForm } from "@cnote/next-kit/client";
import { Store } from "lucide-react";
import { SELLER_APP_URL } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div className="flex items-center gap-2">
        <span className="grid size-9 place-items-center rounded-lg bg-brand-600 text-white"><Store className="size-5" aria-hidden /></span>
        <h1 className="text-xl font-extrabold tracking-tight text-ink">Storefront Studio</h1>
      </div>
      <p className="text-sm text-muted">Sign in with your seller account to build and publish your storefront.</p>
      <SignInForm next={next} googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID)} allowSignUp={false} paths={{ forgot: `${SELLER_APP_URL}/forgot-password` }} />
      <p className="text-center text-sm text-muted">
        New seller?{" "}
        <a href={`${SELLER_APP_URL}/signup`} className="font-medium text-brand-700 hover:underline">Create your seller account</a>, then come back here.
      </p>
    </main>
  );
}
