import { ROLE_PRIVILEGES, isRole } from "@cnote/admin";
import { signOutAction } from "@cnote/next-kit";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { Mono } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate } from "@/lib/util";

export const metadata = { title: "My account" };

export default async function AccountPage() {
  const { session, staff } = await requireStaff("/account");
  return (
    <>
      <PageHeader title="My account" description="Who you are signed in as and what you can do." actions={<form action={signOutAction}><Button type="submit" variant="outline">Sign out</Button></form>} />
      <Card>
        <CardHeader><CardTitle>Identity</CardTitle></CardHeader>
        <CardBody className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
          <span className="text-muted">Name</span><span>{session.name ?? "—"}</span>
          <span className="text-muted">Email</span><span>{session.email ?? "—"}</span>
          <span className="text-muted">Person ID</span><span><Mono>{session.personId}</Mono></span>
          <span className="text-muted">Staff since</span><span>{fmtDate(staff.createdAt)}</span>
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>Roles and privileges</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          {staff.roles.filter(isRole).map((r) => (
            <div key={r}>
              <p className="mb-1 text-sm font-semibold">{r}</p>
              <div className="flex flex-wrap gap-1.5">{ROLE_PRIVILEGES[r].map((p) => <Badge key={p} tone="brand">{p}</Badge>)}</div>
            </div>
          ))}
          <p className="text-xs text-muted">Effective privileges: {staff.privileges.length}</p>
        </CardBody>
      </Card>
    </>
  );
}
