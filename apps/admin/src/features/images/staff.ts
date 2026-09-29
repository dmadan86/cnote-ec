import "server-only";
import { getStaff, type StaffView } from "@cnote/admin";
import { currentSession } from "@cnote/next-kit";

/** For route handlers (no redirects): null = not signed in; { staff: null } = signed in but not staff. */
export async function getStaffFromSession(): Promise<{ staff: StaffView | null } | null> {
  const session = await currentSession();
  if (!session) return null;
  return { staff: await getStaff(session.personId) };
}
