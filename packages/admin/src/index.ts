// @cnote/admin — staff RBAC + audit trail for the separately hosted admin app.
// Queries ONLY StaffMember and AdminAuditLog. The admin app composes other modules via their
// public exports and wraps every mutation in `audited()`.
// PUBLIC CONTRACT. Extend, don't break.
export { PRIVILEGES, ROLES, ROLE_PRIVILEGES, isRole, privilegesFor } from "./rbac";
export type { Privilege, Role } from "./rbac";
export * from "./staff";
export * from "./audit";
