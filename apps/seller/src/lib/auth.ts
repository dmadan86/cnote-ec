import "server-only";
import { redirect } from "next/navigation";
import { requireBusiness, type SessionWithBusiness } from "@cnote/next-kit";

/** Session + business that is a seller; anyone else goes to onboarding. */
export async function requireSeller(returnTo: string): Promise<SessionWithBusiness> {
  const session = await requireBusiness(returnTo, { onboardingPath: "/onboarding" });
  if (!session.business.isSeller) redirect("/onboarding");
  return session;
}
