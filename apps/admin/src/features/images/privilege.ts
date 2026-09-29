import { hasPrivilege, type Privilege, type StaffView } from "@cnote/admin";

export const IMAGES_MODERATE: Privilege = "images.moderate";

/** Viewing the queue needs images.moderate or listings.moderate. */
export const canViewImages = (staff: Pick<StaffView, "privileges">) => hasPrivilege(staff, IMAGES_MODERATE) || hasPrivilege(staff, "listings.moderate");
export const canModerateImages = (staff: Pick<StaffView, "privileges">) => hasPrivilege(staff, IMAGES_MODERATE);
