import { isBusinessMember as identityIsBusinessMember } from "@cnote/identity";

/** Membership check, delegated to @cnote/identity's public directory. */
export const isBusinessMember: (personId: string, businessId: string) => Promise<boolean> = identityIsBusinessMember;
