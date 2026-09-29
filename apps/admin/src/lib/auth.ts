import "server-only";
// Server-side staff gate. Everything privileged goes through requireStaff() (pages/layouts) or
// actionContext() (server actions) — the proxy is only a first line of defence.
import { type AdminContext, type Privilege, type StaffView, getStaff, hasPrivilege } from "@cnote/admin";
import { DomainError } from "@cnote/core";
import { currentSession, requestContext, requireSession } from "@cnote/next-kit";
import type { Session } from "@cnote/identity";
import { redirect } from "next/navigation";
import { cache } from "react";

const loadStaff = cache((personId: string) => getStaff(personId));

/** Session + active StaffMember (else redirect), optionally requiring a privilege (else redirect to /no-access). */
export async function requireStaff(returnTo: string, privilege?: Privilege): Promise<{ session: Session; staff: StaffView; ctx: AdminContext }> {
  const session = await requireSession(returnTo, { signInPath: "/signin" });
  const staff = await loadStaff(session.personId);
  if (!staff) redirect("/no-access");
  if (privilege && !hasPrivilege(staff, privilege)) redirect(`/no-access?need=${encodeURIComponent(privilege)}`);
  const rc = await requestContext();
  return { session, staff, ctx: { staff, ip: rc.ip, userAgent: rc.userAgent } };
}

/** For server actions: throws DomainError (mapped by runAction) instead of redirecting. Fresh staff lookup every call. */
export async function actionContext(): Promise<AdminContext> {
  const session = await currentSession();
  if (!session) throw new DomainError("unauthenticated", "Your session expired. Please sign in again.");
  const staff = await loadStaff(session.personId);
  if (!staff) throw new DomainError("forbidden", "You don't have admin access.");
  const rc = await requestContext();
  return { staff, ip: rc.ip, userAgent: rc.userAgent };
}

/** Same-origin relative path only (open-redirect guard). */
export function safeNext(next: string | string[] | undefined): string | undefined {
  const v = Array.isArray(next) ? next[0] : next;
  return v && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : undefined;
}
