import { DomainError } from "@cnote/core";
import { type Privilege } from "./rbac";

export interface StaffView {
  id: string;
  personId: string;
  roles: string[];
  /** Derived from roles at load time. */
  privileges: Privilege[];
  lastSeenAt: string | null;
  createdAt: string;
}

/** Who is acting + request metadata for the audit trail. Build once per request/action. */
export interface AdminContext {
  staff: StaffView;
  ip?: string | null;
  userAgent?: string | null;
}

export function hasPrivilege(staff: Pick<StaffView, "privileges">, privilege: Privilege): boolean {
  return staff.privileges.includes(privilege);
}

/** Throws DomainError("forbidden") when the staff member lacks the privilege. */
export function requirePrivilege(staff: Pick<StaffView, "privileges">, privilege: Privilege): void {
  if (!hasPrivilege(staff, privilege)) throw new DomainError("forbidden", "You don't have permission to do that.", { privilege });
}
