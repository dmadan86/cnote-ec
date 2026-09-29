import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { findMonorepoRoot, readImageDimensions, sha256Hex, sniffImageMime } from "@cnote/media";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { appUrl } from "./assemble";
import { TEMPLATE_ASSET_PATH } from "./sanitize";

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
export const MAX_ASSET_DIMENSION = 6000;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MIME: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const KEY = /^templates\/[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

export interface TemplateAssetView {
  id: string;
  /** Path stored inside template content; the web app serves it publicly (absolute-ised at render time). */
  url: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  altText: string | null;
  createdAt: string;
}

const view = (a: { id: string; mimeType: string; bytes: number; width: number | null; height: number | null; altText: string | null; createdAt: Date }): TemplateAssetView => ({
  id: a.id,
  url: `/media/template-assets/${a.id}`,
  mimeType: a.mimeType,
  bytes: a.bytes,
  width: a.width,
  height: a.height,
  altText: a.altText,
  createdAt: a.createdAt.toISOString(),
});

function gifSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 10) return null;
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  return width && height ? { width, height } : null;
}

function sniff(b: Uint8Array): string | null {
  const m = sniffImageMime(b);
  if (m) return m;
  const head = String.fromCharCode(...b.slice(0, 6));
  return head === "GIF87a" || head === "GIF89a" ? "image/gif" : null;
}

// Storage: same MEDIA_DIR root as @cnote/media, key `templates/<id>.<ext>`. (@cnote/media's LocalMediaStore only
// accepts listing keys, so template assets use a small dedicated writer until it is generalised; S3 arrives with it.)
function root(): string {
  if ((process.env.MEDIA_DRIVER ?? "local") !== "local") throw new Error(`MEDIA_DRIVER=${process.env.MEDIA_DRIVER} is not supported for template assets yet`);
  const dir = process.env.MEDIA_DIR || ".data/media";
  return path.isAbsolute(dir) ? dir : path.resolve(findMonorepoRoot(), dir);
}
function file(key: string): string {
  if (!KEY.test(key)) throw new Error("Invalid template asset key");
  return path.resolve(root(), key);
}

/** Validate (jpeg/png/webp/gif ≤ 2 MB, readable dimensions) and store. Content type comes from magic bytes, never the client. */
export async function uploadTemplateAsset(bytes: Uint8Array, opts: { altText?: string | null; uploadedBy?: string | null } = {}): Promise<TemplateAssetView> {
  if (bytes.length === 0) throw new DomainError("validation", "The file is empty.");
  if (bytes.length > MAX_ASSET_BYTES) throw new DomainError("validation", "Image is larger than 2 MB.");
  const mime = sniff(bytes);
  if (!mime) throw new DomainError("validation", "Only JPEG, PNG, WebP or GIF images are allowed.");
  const dim = mime === "image/gif" ? gifSize(bytes) : readImageDimensions(bytes, mime as "image/jpeg");
  if (!dim) throw new DomainError("validation", "Could not read the image; the file may be corrupt.");
  if (dim.width > MAX_ASSET_DIMENSION || dim.height > MAX_ASSET_DIMENSION) throw new DomainError("validation", `Image must be at most ${MAX_ASSET_DIMENSION}x${MAX_ASSET_DIMENSION} pixels.`);
  const id = randomUUID();
  const ext = EXT[mime]!;
  const key = `templates/${id}.${ext}`;
  const p = file(key);
  await mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, p);
  try {
    const row = await prisma.templateAsset.create({
      data: { id, storageKey: key, mimeType: mime, bytes: bytes.length, width: dim.width, height: dim.height, sha256: sha256Hex(bytes), altText: opts.altText?.slice(0, 300) || null, uploadedBy: opts.uploadedBy ?? null },
    });
    return view(row);
  } catch (e) {
    await rm(p, { force: true });
    throw e;
  }
}

export async function listTemplateAssets(limit = 100): Promise<(TemplateAssetView & { inUse: boolean })[]> {
  const rows = await prisma.templateAsset.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return Promise.all(rows.map(async (r) => ({ ...view(r), inUse: (await assetUsage(r.id)) > 0 })));
}

/** Bytes for the public/admin media routes. Null when unknown. */
export async function readTemplateAsset(id: string): Promise<{ bytes: Uint8Array; contentType: string; sha256: string } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const row = await prisma.templateAsset.findUnique({ where: { id: id.toLowerCase() } });
  if (!row) return null;
  try {
    const buf = await readFile(file(row.storageKey));
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), contentType: MIME[row.storageKey.split(".").pop()!]!, sha256: row.sha256 };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Number of template/layout versions (any status) and layout themes that reference the asset. */
async function assetUsage(id: string): Promise<number> {
  const [t, l, th] = await Promise.all([
    prisma.messageTemplateVersion.count({ where: { body: { contains: id } } }),
    prisma.messageLayoutVersion.count({ where: { OR: [{ headerHtml: { contains: id } }, { footerHtml: { contains: id } }] } }),
    prisma.messageLayoutVersion.count({ where: { theme: { path: ["logoAssetId"], equals: id } } }),
  ]);
  return t + l + th;
}

/** Deletes the asset only when no version (draft, published or archived) references it. */
export async function deleteTemplateAsset(id: string): Promise<void> {
  const row = await prisma.templateAsset.findUnique({ where: { id } });
  if (!row) throw new DomainError("not_found", "Image not found.");
  if ((await assetUsage(id)) > 0) throw new DomainError("conflict", "This image is used by a template or layout version and can't be deleted.");
  await prisma.templateAsset.delete({ where: { id } });
  await rm(file(row.storageKey), { force: true });
}

/**
 * Rewrites `/media/template-assets/<id>` URLs in rendered HTML: "absolute" → APP_URL origin (emails),
 * "inline" → data: URIs (sandboxed admin preview, which can't send cookies or reach the web app in dev).
 */
export async function resolveAssetUrls(html: string, mode: "absolute" | "inline"): Promise<string> {
  const re = /(src=")(\/media\/template-assets\/[0-9a-f-]{36})(")/gi;
  const found = new Set<string>();
  for (const m of html.matchAll(re)) found.add(m[2]!);
  if (!found.size) return html;
  const map = new Map<string, string>();
  for (const p of found) {
    if (!TEMPLATE_ASSET_PATH.test(p)) continue;
    if (mode === "absolute") map.set(p, `${appUrl()}${p}`);
    else {
      const a = await readTemplateAsset(p.split("/").pop()!);
      map.set(p, a ? `data:${a.contentType};base64,${Buffer.from(a.bytes).toString("base64")}` : `${appUrl()}${p}`);
    }
  }
  return html.replace(re, (_m, a: string, p: string, c: string) => `${a}${map.get(p) ?? p}${c}`);
}
