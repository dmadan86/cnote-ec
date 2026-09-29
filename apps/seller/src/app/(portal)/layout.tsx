import { AppShell } from "@/features/shell/app-shell";
import { requireSeller } from "@/lib/auth";

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSeller("/dashboard");
  return <AppShell session={session}>{children}</AppShell>;
}
