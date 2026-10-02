import { exportAlertsData } from "@cnote/alerts";
import { exportPersonalData } from "@cnote/identity";
import { currentSession } from "@cnote/next-kit";
import { NextResponse } from "next/server";

/** DPDP access right (ADR-010): download everything we hold about the signed-in person. */
export async function GET() {
  const s = await currentSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const [data, alerts] = await Promise.all([exportPersonalData(s.personId), exportAlertsData(s.personId)]);
  // followed suppliers, saved searches and alert opt-ins (docs/design/buyer-retention.md)
  const body = Object.keys(data).length ? { ...data, ...alerts } : data;
  return new NextResponse(JSON.stringify(body, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="my-data.json"',
      "cache-control": "no-store",
    },
  });
}
