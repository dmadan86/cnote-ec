import { Shell } from "@/components/shell";
import { requireStaff } from "@/lib/auth";

export default async function ConsoleLayout({ children }: LayoutProps<"/">) {
  const { session, staff } = await requireStaff("/");
  return (
    <Shell staff={staff} name={session.name ?? session.email ?? "Staff"}>
      {children}
    </Shell>
  );
}
