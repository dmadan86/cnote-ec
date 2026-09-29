import { ROLES, ROLE_PRIVILEGES, hasPrivilege, listStaff } from "@cnote/admin";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Field, Input, PageHeader } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Mono, Table, Td, Th } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";
import { deactivateStaffAction, grantStaffAction, updateRolesAction } from "./actions";

export const metadata = { title: "Staff" };

function RoleChecks({ current }: { current: string[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {ROLES.map((r) => (
        <label key={r} className="flex items-center gap-1.5 text-sm" title={ROLE_PRIVILEGES[r].join(", ")}>
          <input type="checkbox" name="roles" value={r} defaultChecked={current.includes(r)} className="size-4 accent-brand-600" /> {r}
        </label>
      ))}
    </div>
  );
}

export default async function StaffPage() {
  const { ctx, staff, staff: me } = await requireStaff("/staff", "staff.read");
  const canManage = hasPrivilege(staff, "staff.manage");
  const list = await safe("listStaff", () => listStaff(ctx));
  return (
    <>
      <PageHeader title="Staff" description="Who has back-office access and with which roles. Hover a role for its privileges." />
      {list === null ? <Alert tone="warning">Staff list unavailable.</Alert> : (
        <Table>
          <thead><tr><Th>Person ID</Th><Th>Roles</Th><Th>Status</Th><Th>Last seen</Th>{canManage ? <Th>Manage</Th> : null}</tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <Td><Mono>{s.personId}</Mono>{s.personId === me.personId ? <Badge tone="brand" className="ml-2">you</Badge> : null}</Td>
                <Td>{s.roles.join(", ") || "—"}</Td>
                <Td><Badge tone={s.active ? "success" : "neutral"}>{s.active ? "active" : "inactive"}</Badge></Td>
                <Td className="whitespace-nowrap">{s.lastSeenAt ? fmtDate(s.lastSeenAt) : "never"}</Td>
                {canManage ? (
                  <Td>
                    <ActionForm action={updateRolesAction} className="space-y-2" successMessage="Roles updated.">
                      <input type="hidden" name="personId" value={s.personId} />
                      <RoleChecks current={s.roles} />
                      <div className="flex gap-2">
                        <SubmitButton size="sm" variant="outline">Save roles</SubmitButton>
                      </div>
                    </ActionForm>
                    {s.active ? (
                      <ActionForm action={deactivateStaffAction} confirm="Deactivate this staff member? They lose access immediately." className="mt-2" successMessage="Deactivated.">
                        <input type="hidden" name="personId" value={s.personId} />
                        <SubmitButton size="sm" variant="ghost" className="text-danger">Deactivate</SubmitButton>
                      </ActionForm>
                    ) : null}
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {canManage ? (
        <Card>
          <CardHeader><CardTitle>Grant access</CardTitle></CardHeader>
          <CardBody className="space-y-4">
            <Alert tone="info">
              Granting by email isn&apos;t available in the UI yet (identity has no person-by-email lookup). Use the CLI:{" "}
              <code>pnpm admin:grant &lt;email&gt; &lt;role...&gt;</code>. Or, if you already have the person&apos;s ID, use the form below.
            </Alert>
            <ActionForm action={grantStaffAction} className="space-y-3" successMessage="Access granted.">
              <Field label="Person ID (UUID)" htmlFor="personId" className="max-w-md"><Input id="personId" name="personId" required pattern="[0-9a-fA-F-]{36}" autoComplete="off" /></Field>
              <RoleChecks current={[]} />
              <SubmitButton>Grant access</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}
