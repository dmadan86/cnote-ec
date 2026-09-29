"use server";
import { deactivateStaff, grantStaff, updateStaffRoles } from "@cnote/admin";
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
