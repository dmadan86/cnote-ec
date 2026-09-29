import { exportPersonalData } from "@cnote/identity";
import { currentSession } from "@cnote/next-kit";
import { NextResponse } from "next/server";

/** DPDP access right (ADR-010): download everything we hold about the signed-in person. */
export async function GET() {
  const s = await currentSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const data = await exportPersonalData(s.personId);
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="my-data.json"',
      "cache-control": "no-store",
    },
  });
}
