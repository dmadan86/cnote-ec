import { timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { invalidateTags } from "@cnote/core";

/**
 * Cache purge endpoint (event-driven invalidation). Called by the cache worker (@cnote/search `cacheWorker`) on
 * ListingPublished/Moderated/Archived, ListingImageModerated, ReviewModerated, TrustScoreChanged, BusinessVerified ...
 *
 *   POST /api/revalidate      Authorization: Bearer $REVALIDATE_SECRET
 *   { "tags": ["listing:<id>", { "tag": "featured", "hard": false }], "paths": ["/categories"] }
 *
 * soft (default): stale-while-revalidate, the next request is served instantly from the old copy while it rebuilds.
 * hard: blocking revalidate, stale content is never served (use for moderation: a rejected listing must vanish now).
 * Redis tags are purged as well, so callers only need this one endpoint. Disabled (503) when REVALIDATE_SECRET is unset.
 */
const TAG_RE = /^[A-Za-z0-9:_\-.]{1,200}$/;

function authorised(req: Request, secret: string): boolean {
  const given = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  if (!secret) return NextResponse.json({ error: "disabled" }, { status: 503 });
  if (!authorised(req, secret)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: { tags?: unknown; paths?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const tags = (Array.isArray(body.tags) ? body.tags : []).slice(0, 200).flatMap((t): { tag: string; hard: boolean }[] => {
    const tag = typeof t === "string" ? t : t && typeof t === "object" && typeof (t as { tag?: unknown }).tag === "string" ? (t as { tag: string }).tag : "";
    const hard = typeof t === "object" && t !== null && (t as { hard?: unknown }).hard === true;
    return TAG_RE.test(tag) ? [{ tag, hard }] : [];
  });
  const paths = (Array.isArray(body.paths) ? body.paths : []).slice(0, 50).filter((p): p is string => typeof p === "string" && p.startsWith("/") && p.length <= 300);

  for (const { tag, hard } of tags) revalidateTag(tag, hard ? { expire: 0 } : "max");
  for (const p of paths) revalidatePath(p);
  await invalidateTags(tags.filter((t) => t.hard).map((t) => t.tag));
  return NextResponse.json({ revalidated: { tags: tags.length, paths: paths.length } }, { headers: { "Cache-Control": "no-store" } });
}
