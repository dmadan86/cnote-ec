import { personalExportStream } from "@cnote/compliance";
import { rateLimit } from "@cnote/core";
import { currentSession } from "@cnote/next-kit";
import { NextResponse } from "next/server";

/** Streams a JSON document, so this must never be statically cached or buffered by the framework. */
export const dynamic = "force-dynamic";

/**
 * DPDP access right (s.11, ADR-010; audit M10): download everything we hold about the signed-in person, from EVERY module
 * (see the export registry in @cnote/compliance). Rate-limited per person, size-bounded and streamed.
 */
export async function GET() {
  const s = await currentSession();
  if (!s) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  // An export fans out into queries across every module: 3 per hour per person is plenty for a legal right, and cheap to enforce.
  if (!(await rateLimit(`account-export:${s.personId}`, 3, 3600))) {
    return NextResponse.json({ error: "rate_limited", message: "You can download your data 3 times an hour. Please try again later." }, { status: 429, headers: { "retry-after": "3600" } });
  }
  return new NextResponse(personalExportStream(s.personId), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="my-data.json"',
      "cache-control": "no-store",
    },
  });
}
