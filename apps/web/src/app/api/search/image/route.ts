import { deriveImageSearch, PHOTO_CATEGORY_CONFIDENCE } from "@cnote/ai";
import { DomainError } from "@cnote/core";
import { ImageValidationError, processImage, validateImage } from "@cnote/media";
import { verifyHuman } from "@cnote/security";
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { asLang, clientIp, fail, limited, NO_STORE, tooLarge } from "@/features/search/api-guard";
import { loadCategories } from "@/features/search/data";

// Search by photo (ADR-004, ADR-008). The upload is validated (@cnote/media validateImage: magic bytes, size, dimensions),
// re-encoded in memory to a <=960 px JPEG (drops EXIF/GPS/ICC), sent to the vision capability and DROPPED: never stored.
// Public + paid vendor call, so: per-IP rate limit and the human-verification check (Turnstile; passes with the dev
// adapter outside production when no secret is set, fails closed in production without one).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const LIMIT = { count: 6, windowSeconds: 60 };
const ZERO_ID = "00000000-0000-4000-8000-000000000000";

export async function POST(req: NextRequest) {
  const blocked = await limited(req, "image", LIMIT.count, LIMIT.windowSeconds);
  if (blocked) return blocked;
  if (tooLarge(req, MAX_PHOTO_BYTES + 50_000)) return fail(413, "too_large");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "bad_request");
  }
  const token = form.get("cf-turnstile-response");
  const human = await verifyHuman(typeof token === "string" ? token : null, clientIp(req));
  if (!human.ok) return fail(403, "human_check_failed");

  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) return fail(400, "no_image");
  const lang = asLang(form.get("lang"));

  try {
    const original = new Uint8Array(await file.arrayBuffer());
    validateImage(original);
    // re-encode: strips every metadata block and bounds the size sent to the vendor
    const { variants, width, height } = await processImage(original, { listingId: ZERO_ID, imageId: randomUUID() }, { widths: [960, 640, 320, 200], formats: ["jpeg"] });
    const best = [...variants].sort((a, b) => b.width - a.width)[0]!;
    const categories = (await loadCategories()).map((c) => ({ slug: c.slug, name: c.name, attributeSchema: null }));
    const r = await deriveImageSearch(
      { images: [{ bytes: best.data, mimeType: "image/jpeg", width: best.width, height: Math.round((best.width * height) / width) }], language: lang, categories },
      { type: "listing", id: randomUUID() },
    );
    const category = r.categorySlug && r.confidence >= PHOTO_CATEGORY_CONFIDENCE ? r.categorySlug : null;
    return NextResponse.json({ query: r.query, keywords: r.keywords, category, confidence: r.confidence }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof ImageValidationError) return fail(400, "invalid_image", { message: err.message });
    if (err instanceof DomainError && err.code === "validation") return fail(400, "invalid_image");
    console.error("[web] /api/search/image failed:", err instanceof Error ? err.message : err);
    return fail(502, "photo_search_failed");
  }
}
