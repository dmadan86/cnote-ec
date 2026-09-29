import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { audited } from "./audit";
import { type AdminContext, type StaffView, requirePrivilege } from "./context";
import { ROLES, isRole, privilegesFor } from "./rbac";

export { hasPrivilege, requirePrivilege } from "./context";
export type { AdminContext, StaffView } from "./context";

const TOUCH_INTERVAL_MS = 5 * 60_000;

type Row = { id: string; personId: string; roles: string[]; lastSeenAt: Date | null; createdAt: Date };
const toView = (r: Row): StaffView => ({
  id: r.id,
  personId: r.personId,
  roles: r.roles.filter(isRole),
  privileges: [...privilegesFor(r.roles)],
  lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** Active staff member for a person, or null (no row / deactivated). Touches lastSeenAt at most every 5 minutes. */
export async function getStaff(personId: string): Promise<StaffView | null> {
  if (!z.uuid().safeParse(personId).success) return null;
  const row = await prisma.staffMember.findUnique({ where: { personId } });
  if (!row || !row.active) return null;
  const now = Date.now();
  if (!row.lastSeenAt || now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await prisma.staffMember
      .update({ where: { id: row.id }, data: { lastSeenAt: new Date(now) }, select: { id: true } })
      .catch(() => undefined); // best effort; never block a request on a heartbeat
    row.lastSeenAt = new Date(now);
  }
  return toView(row);
}

export interface StaffListItem extends StaffView {
  active: boolean;
  createdBy: string | null;
}

/** Requires staff.read. Includes deactivated members. Person details are identity's data: callers resolve personId. */
export async function listStaff(ctx: AdminContext): Promise<StaffListItem[]> {
  requirePrivilege(ctx.staff, "staff.read");
  const rows = await prisma.staffMember.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map((r) => ({ ...toView(r), active: r.active, createdBy: r.createdBy }));
}

const rolesSchema = z
  .array(z.enum(ROLES))
  .min(1, "Pick at least one role")
  .max(ROLES.length)
  .transform((r) => [...new Set(r)]);
const personIdSchema = z.uuid();

/**
 * Guard shared by role changes, deactivation and the CLI: after the change there must still be at
 * least one active super_admin, and nobody may strip their own super_admin. Runs in a serializable
 * transaction so two concurrent demotions can't both pass.
 */
export async function applyStaffChange(
  target: { personId: string },
  change: { roles?: string[]; active?: boolean; createdBy?: string | null; upsert?: boolean },
  opts: { actorPersonId?: string | null } = {},
): Promise<{ before: { roles: string[]; active: boolean } | null; after: { roles: string[]; active: boolean } }> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        const existing = await tx.staffMember.findUnique({ where: { personId: target.personId } });
        if (!existing && !change.upsert) throw new DomainError("not_found", "Staff member not found.");
        const nextRoles = change.roles ?? existing?.roles ?? [];
        const nextActive = change.active ?? existing?.active ?? true;
        const wasSuper = !!existing?.active && existing.roles.includes("super_admin");
        const willBeSuper = nextActive && nextRoles.includes("super_admin");
        if (wasSuper && !willBeSuper) {
          if (opts.actorPersonId && opts.actorPersonId === target.personId) {
            throw new DomainError("conflict", "You can't remove your own super_admin access.");
          }
          const others = await tx.staffMember.count({
            where: { active: true, roles: { has: "super_admin" }, personId: { not: target.personId } },
          });
          if (others === 0) throw new DomainError("conflict", "This is the last super_admin; promote someone else first.");
        }
        await tx.staffMember.upsert({
          where: { personId: target.personId },
          create: { personId: target.personId, roles: nextRoles, active: nextActive, createdBy: change.createdBy ?? null },
          update: { roles: nextRoles, active: nextActive },
        });
        return {
          before: existing ? { roles: existing.roles, active: existing.active } : null,
          after: { roles: nextRoles, active: nextActive },
        };
      },
      { isolationLevel: "Serializable" },
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2003") throw new DomainError("not_found", "No such person.");
    if (code === "P2034") throw new DomainError("conflict", "Concurrent change detected; please retry.");
    throw err;
  }
}

/** Grant (or re-activate with new roles) staff access to a person. Requires staff.manage. */
export async function grantStaff(ctx: AdminContext, personId: string, roles: string[]): Promise<void> {
  const pid = personIdSchema.parse(personId);
  const rs = rolesSchema.parse(roles);
  await audited(
    ctx,
    "staff.manage",
    "staff.grant",
    { type: "person", id: pid },
    async () => {
      await applyStaffChange({ personId: pid }, { roles: rs, active: true, createdBy: ctx.staff.id, upsert: true }, { actorPersonId: ctx.staff.personId });
    },
    { roles: rs },
  );
}

export async function updateStaffRoles(ctx: AdminContext, personId: string, roles: string[]): Promise<void> {
  const pid = personIdSchema.parse(personId);
  const rs = rolesSchema.parse(roles);
  await audited(
    ctx,
    "staff.manage",
    "staff.roles.update",
    { type: "person", id: pid },
    async () => {
      await applyStaffChange({ personId: pid }, { roles: rs }, { actorPersonId: ctx.staff.personId });
    },
    { roles: rs },
  );
}

export async function deactivateStaff(ctx: AdminContext, personId: string): Promise<void> {
  const pid = personIdSchema.parse(personId);
  await audited(ctx, "staff.manage", "staff.deactivate", { type: "person", id: pid }, async () => {
    await applyStaffChange({ personId: pid }, { active: false }, { actorPersonId: ctx.staff.personId });
  });
}
