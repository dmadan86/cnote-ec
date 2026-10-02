import { listAddresses } from "@cnote/identity";
import { currentSession } from "@cnote/next-kit";
import { NextResponse } from "next/server";

/**
 * Saved delivery addresses of the signed-in buyer, for the header "Deliver to" picker. Always private and uncacheable
 * (the header itself is static, so personal data is only ever fetched here, per request). Signed out: empty list.
 */
export async function GET() {
  const headers = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };
  let session = null;
  try {
    session = await currentSession();
  } catch {
    /* treat any failure as signed out */
  }
  if (!session?.business) return NextResponse.json({ addresses: [] }, { headers });
  const rows = await listAddresses(session.business.id).catch(() => []);
  return NextResponse.json({ addresses: rows.map((a) => ({ id: a.id, label: a.label, city: a.city, pincode: a.pincode, isDefault: a.isDefault })) }, { headers });
}
