import { safeNext } from "@/lib/auth";
import { SignInForm } from "@cnote/next-kit/client";

export const metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  const sp = await searchParams;
  return <SignInForm next={safeNext(sp.next)} allowSignUp={false} googleEnabled={!!process.env.GOOGLE_CLIENT_ID} paths={{ signIn: "/signin", forgot: "/forgot-password" }} />;
}
