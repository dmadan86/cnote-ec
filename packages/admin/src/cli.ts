// Bootstrap / break-glass CLI for staff access. Run from the repo root:
//   pnpm admin:grant <email> <role...>            grant (or replace roles; re-activates)
//   pnpm --filter @cnote/admin staff:list         list staff
//   pnpm --filter @cnote/admin staff:revoke <email>   deactivate
// Every change writes an AdminAuditLog row with staffId = null (CLI/system).
//
// Boundary note: Person belongs to @cnote/identity and identity has no lookup-by-email export.
// This CLI is an operator bootstrap tool (the first super_admin must exist before any UI does), so a
// direct read-only prisma lookup of persons by email is acceptable here. Nothing else in this
// package touches the persons table.
import { prisma } from "@cnote/db";
import { ROLES, isRole } from "./rbac";
import { applyStaffChange } from "./staff";
import { writeAudit } from "./audit";

const usage = `Usage:
  grant <email> <role...>   roles: ${ROLES.join(", ")}
  list
  revoke <email>`;

async function personByEmail(email: string) {
  const person = await prisma.person.findUnique({ where: { email: email.trim().toLowerCase() }, select: { id: true, email: true } });
  if (!person) throw new Error(`No person with email ${email}. They must sign up (or sign in with Google) on the public site first.`);
  return person;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "grant": {
      const [email, ...roles] = args;
      if (!email || roles.length === 0) throw new Error(usage);
      const bad = roles.filter((r) => !isRole(r));
      if (bad.length) throw new Error(`Unknown role(s): ${bad.join(", ")}. Valid: ${ROLES.join(", ")}`);
      const person = await personByEmail(email);
      const uniq = [...new Set(roles)];
      const res = await applyStaffChange({ personId: person.id }, { roles: uniq, active: true, upsert: true, createdBy: null });
      await writeAudit({
        staffId: null,
        privilege: "staff.manage",
        action: "staff.grant",
        subject: { type: "person", id: person.id },
        details: { via: "cli", email: person.email, roles: uniq, before: res.before },
      });
      console.log(`Granted ${uniq.join(", ")} to ${person.email} (${person.id}).`);
      break;
    }
    case "revoke": {
      const [email] = args;
      if (!email) throw new Error(usage);
      const person = await personByEmail(email);
      const res = await applyStaffChange({ personId: person.id }, { active: false });
      await writeAudit({
        staffId: null,
        privilege: "staff.manage",
        action: "staff.deactivate",
        subject: { type: "person", id: person.id },
        details: { via: "cli", email: person.email, before: res.before },
      });
      console.log(`Deactivated ${person.email}.`);
      break;
    }
    case "list": {
      const rows = await prisma.staffMember.findMany({ orderBy: { createdAt: "asc" }, include: { person: { select: { email: true } } } });
      if (!rows.length) console.log("No staff yet. Run: pnpm admin:grant <email> super_admin");
      for (const r of rows) console.log(`${r.active ? "active  " : "inactive"}  ${(r.person.email ?? r.personId).padEnd(36)} ${r.roles.join(",")}`);
      break;
    }
    default:
      throw new Error(usage);
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
