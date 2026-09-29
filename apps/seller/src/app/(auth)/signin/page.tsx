import type { Metadata } from "next";
import { SignInForm } from "@cnote/next-kit/client";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return <SignInForm next={next} googleEnabled={Boolean(process.env.GOOGLE_CLIENT_ID)} />;
}
