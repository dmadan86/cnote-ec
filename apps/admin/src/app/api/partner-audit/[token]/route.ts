import { DomainError, rateLimit } from "@cnote/core";
import { submitAuditByPartner, MAX_AUDIT_PHOTOS, MAX_AUDIT_PHOTO_BYTES } from "@cnote/identity";
import { errorResponse, readBoundedFormData } from "@cnote/next-kit";
import { clientIp } from "@cnote/security/client-ip";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ensureKycPorts } from "@/features/kyc/ports";

// Public (token-authenticated) T3 partner submission. The single-use signed link IS the credential; nothing else is trusted.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = MAX_AUDIT_PHOTOS * MAX_AUDIT_PHOTO_BYTES + 512 * 1024;

const meta = z.array(z.object({ lat: z.number().min(-90).max(90).nullable(), lng: z.number().min(-180).max(180).nullable(), capturedAt: z.string().max(40).nullable() })).max(MAX_AUDIT_PHOTOS);
const answers = z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), z.object({ ok: z.boolean(), note: z.string().max(300).optional() }));

export async function POST(req: Request, ctx: RouteContext<"/api/partner-audit/[token]">) {
  try {
    const { token } = await ctx.params;
    const ip = clientIp(req.headers) ?? "unknown";
    const key = createHash("sha256").update(token).digest("hex").slice(0, 16);
    if (!(await rateLimit(`partner-audit:ip:${ip}`, 20, 3600)) || !(await rateLimit(`partner-audit:tok:${key}`, 10, 3600))) throw new DomainError("rate_limited", "Too many attempts. Try again later.");
    const form = await readBoundedFormData(req, MAX_BYTES);
    const metas = meta.parse(JSON.parse(String(form.get("photos") ?? "[]")));
    const photos = [];
    for (let i = 0; i < metas.length; i++) {
      const f = form.get(`photo${i}`);
      if (!(f instanceof File) || f.size === 0) throw new DomainError("validation", "A photo is missing.");
      photos.push({ bytes: new Uint8Array(await f.arrayBuffer()), ...metas[i]! });
    }
    ensureKycPorts();
    const out = await submitAuditByPartner(token, {
      inspector: String(form.get("inspector") ?? ""),
      summary: String(form.get("summary") ?? ""),
      answers: answers.parse(JSON.parse(String(form.get("answers") ?? "{}"))),
      photos,
    });
    // flags are for staff only: do not coach the partner on what the automatic checks look for
    return Response.json({ ok: true, auditId: out.auditId }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof SyntaxError || err instanceof z.ZodError) return errorResponse(new DomainError("validation", "The submission could not be read."));
    return errorResponse(err);
  }
}
