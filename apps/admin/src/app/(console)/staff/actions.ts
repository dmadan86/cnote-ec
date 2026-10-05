"use server";
import { audited, deactivateStaff, grantStaff, updateStaffRoles } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { resetPasskeys } from "@cnote/identity";
import { type ActionResult, runAction } from "@cnote/next-kit";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { actionContext } from "@/lib/auth";

// Authorisation (staff.manage), audit and last-super-admin guards live in @cnote/admin; the
// functions below are audited() internally.
const personId = z.uuid();
const roles = (fd: FormData) => fd.getAll("roles").map(String);

export async function grantStaffAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => grantStaff(await actionContext(), personId.parse(String(fd.get("personId") ?? "").trim()), roles(fd)));
  if (r.ok) revalidatePath("/staff");
  return r;
}
export async function updateRolesAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => updateStaffRoles(await actionContext(), personId.parse(fd.get("personId")), roles(fd)));
  if (r.ok) revalidatePath("/staff");
  return r;
}
export async function deactivateStaffAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => deactivateStaff(await actionContext(), personId.parse(fd.get("personId"))));
  if (r.ok) revalidatePath("/staff");
  return r;
}

/**
 * Recovery for a lost security key (ADR-029, docs/design/admin-passkeys.md): an owner-level staff member (super_admin, via
 * `staff.passkeys.reset`) revokes every passkey of another staff member and signs them out everywhere. Under
 * ADMIN_REQUIRE_PASSKEY the person must sign in with password + TOTP and enroll a new passkey before getting a session.
 */
export async function resetPasskeysAction(_p: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const r = await runAction(async () => {
    const ctx = await actionContext();
    const target = personId.parse(fd.get("personId"));
    if (target === ctx.staff.personId) throw new DomainError("conflict", "Manage your own passkeys on the Security page.");
    await audited(ctx, "staff.passkeys.reset", "staff.passkeys_reset", { type: "Person", id: target }, () => resetPasskeys("admin", target, ctx.staff.id), { targetPersonId: target });
  });
  if (r.ok) revalidatePath("/staff");
  return r;
}
