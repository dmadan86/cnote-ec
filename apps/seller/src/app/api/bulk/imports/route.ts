import { DomainError } from "@cnote/core";
import { LIMITS, createImportJob, listJobs } from "@cnote/bulk";
import { errorResponse } from "@cnote/next-kit";
import { bulkActor } from "@/features/bulk/route-auth";

// Uploads are a raw request body (not multipart, not a server action): actions cap bodies at ~1 MB and a
// multipart parser would buffer twice. Up to 200 MB; the file name and options travel in the query string.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store" };

async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw new DomainError("validation", "File is larger than 200 MB");
  if (!req.body) throw new DomainError("validation", "Choose a file to upload");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new DomainError("validation", "File is larger than 200 MB");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function POST(req: Request) {
  try {
    const actor = await bulkActor();
    const url = new URL(req.url);
    const filename = url.searchParams.get("filename") ?? "";
    if (!filename) throw new DomainError("validation", "Missing file name");
    const bytes = await readCapped(req, LIMITS.maxZipCompressedBytes);
    const job = await createImportJob(actor, { bytes, filename }, {
      mode: url.searchParams.get("mode") === "create" ? "create" : "upsert",
      submitForReview: url.searchParams.get("submit") === "1",
    });
    return Response.json({ ok: true, job }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function GET(req: Request) {
  try {
    const actor = await bulkActor();
    const kind = new URL(req.url).searchParams.get("kind");
    const jobs = await listJobs(actor, { kind: kind === "import" || kind === "export" ? kind : undefined, limit: 20 });
    return Response.json({ ok: true, jobs }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err);
  }
}
