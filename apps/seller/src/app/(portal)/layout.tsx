import { countUnansweredQuestions } from "@cnote/reviews";
import { AppShell } from "@/features/shell/app-shell";
import { requireSeller } from "@/lib/auth";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSeller("/dashboard");
  // Nav badge: a failed count must never break the portal.
  const unanswered = await countUnansweredQuestions(session.business.id).catch(() => 0);
  return <AppShell session={session} unansweredQuestions={unanswered}>{children}</AppShell>;
}
