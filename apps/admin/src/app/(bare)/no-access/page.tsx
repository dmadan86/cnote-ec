import { PRIVILEGES, getStaff } from "@cnote/admin";
import { requireSession, signOutAction } from "@cnote/next-kit";
import { Button, Card, CardBody } from "@cnote/ui";
import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { one } from "@/lib/util";

export const metadata = { title: "No access" };

// Requires a session only. Deliberately reveals nothing beyond "no access".
export default async function NoAccessPage({ searchParams }: PageProps<"/no-access">) {
  const session = await requireSession("/no-access", { signInPath: "/signin" });
  const staff = await getStaff(session.personId);
  const need = one((await searchParams).need);
  const known = need && (PRIVILEGES as readonly string[]).includes(need) ? need : null;
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-md">
        <CardBody className="flex flex-col items-center gap-3 text-center">
          <ShieldAlert className="size-10 text-danger" aria-hidden />
          <h1 className="text-xl font-bold">403 · {staff ? "You don't have access to this section" : "You don't have admin access"}</h1>
          <p className="text-sm text-muted">
            {staff
              ? "Your role doesn't include the privilege needed for this page. Ask a super admin if you think this is a mistake."
              : "This account isn't a member of staff. If you should have access, ask a super admin to grant it."}
          </p>
          {known && staff ? <p className="text-xs text-muted">Missing privilege: <code>{known}</code></p> : null}
          <div className="mt-2 flex gap-2">
            {staff ? <Link href="/" className="inline-flex h-10 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-canvas">Back to dashboard</Link> : null}
            <form action={signOutAction}><Button type="submit" variant="outline">Sign out</Button></form>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
