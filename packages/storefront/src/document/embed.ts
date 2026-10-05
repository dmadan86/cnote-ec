// Third-party embeds in a storefront (the `embed` block): a closed set of providers, never a seller-supplied URL or HTML.
// The seller picks a provider and gives an id / coordinates; the platform builds the iframe URL itself from a fixed, privacy-enhanced
// host (youtube-nocookie.com, openstreetmap.org), so an embed can only ever point at these origins. The renderer hands the result to
// an `Embed` component, which in the buyer web is wrapped in <ConsentGate>: nothing from the provider loads (no request, no cookie)
// until the visitor allows the category or chooses "Load it" for that item (DPDP s.6; ePrivacy Art 5(3); docs/design/cookie-consent.md).
import { z } from "zod";

/** Origins an embed iframe may use. The buyer web's CSP `frame-src` must allow exactly these (see packages/security csp.ts and its test). */
export const EMBED_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://www.openstreetmap.org", "https://player.vimeo.com"] as const;

/**
 * Feature flag `STOREFRONT_EMBEDS_ENABLED` (default OFF). The embed block is seller-facing and its content (a video id, coordinates)
 * is not moderated yet (ADR-003: all seller content is moderated; follow-up in docs/design/cookie-consent.md). While it is off:
 * Studio does not offer the block, the service rejects saving / restoring / publishing a document that contains one (a seller-facing
 * validation error), and a stored document that already has one renders nothing for it. Read on the server (no NEXT_PUBLIC); the
 * Studio editor gets the value as a prop.
 */
export const embedsEnabled = (env: Record<string, string | undefined> = typeof process === "undefined" ? {} : process.env): boolean => ["1", "true"].includes((env.STOREFRONT_EMBEDS_ENABLED ?? "").toLowerCase());

/** True when any page of the document has an `embed` block. */
export const documentHasEmbeds = (doc: { pages: { sections: { type: string }[] }[] }): boolean => doc.pages.some((p) => p.sections.some((s) => s.type === "embed"));

export type EmbedCategory = "marketing" | "functional";
export type EmbedKind = "youtube" | "vimeo" | "map";

export const embedSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("youtube"), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "Use an 11-character YouTube video id.") }),
  z.strictObject({ kind: z.literal("vimeo"), videoId: z.string().regex(/^\d{6,12}$/, "Use the numeric Vimeo video id (6 to 12 digits).") }),
  z.strictObject({
    kind: z.literal("map"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    zoom: z.number().int().min(3).max(18),
  }),
]);
export type EmbedSource = z.infer<typeof embedSourceSchema>;

export interface EmbedSpec {
  kind: EmbedKind;
  /** Named in the consent placeholder ("This content is from YouTube, which may set cookies"). */
  provider: string;
  /** The consent category that unlocks it: video platforms profile viewers (marketing), a plain map tile server only personalises (functional). */
  category: EmbedCategory;
  /** Privacy-enhanced iframe URL, always on one of EMBED_FRAME_ORIGINS. */
  src: string;
  /** Plain link to the same content on the provider's site: the no-JavaScript / no-embed fallback, and what Studio's preview shows. */
  href: string;
}

const round = (n: number, d: number) => Number(n.toFixed(d));

/** Builds the iframe URL, provider and consent category for a validated embed source. Pure; no I/O. */
export function embedSpec(source: EmbedSource): EmbedSpec {
  if (source.kind === "youtube") {
    return {
      kind: "youtube",
      provider: "YouTube",
      category: "marketing",
      src: `https://www.youtube-nocookie.com/embed/${source.videoId}?rel=0`,
      href: `https://www.youtube.com/watch?v=${source.videoId}`,
    };
  }
  if (source.kind === "vimeo") {
    return {
      kind: "vimeo",
      provider: "Vimeo",
      category: "marketing",
      // dnt=1 asks Vimeo not to track the viewer (no session stats cookies); the consent gate still applies first.
      src: `https://player.vimeo.com/video/${source.videoId}?dnt=1`,
      href: `https://vimeo.com/${source.videoId}`,
    };
  }
  // A viewport of about three tiles wide around the point, in OpenStreetMap's bbox form (west,south,east,north).
  const lngSpan = (360 / 2 ** source.zoom) * 1.5;
  const latSpan = lngSpan * 0.6;
  const bbox = [source.lng - lngSpan / 2, source.lat - latSpan / 2, source.lng + lngSpan / 2, source.lat + latSpan / 2].map((n) => round(n, 5)).join(",");
  const marker = `${round(source.lat, 5)},${round(source.lng, 5)}`;
  return {
    kind: "map",
    provider: "OpenStreetMap",
    category: "functional",
    src: `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(marker)}`,
    href: `https://www.openstreetmap.org/?mlat=${round(source.lat, 5)}&mlon=${round(source.lng, 5)}#map=${source.zoom}/${round(source.lat, 5)}/${round(source.lng, 5)}`,
  };
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The 11-character video id from what a seller pastes: a bare id, or a youtube.com / youtu.be / youtube-nocookie.com URL
 * (watch?v=, /embed/, /shorts/, /live/, youtu.be/<id>). Anything else (other hosts, look-alike domains) is null.
 */
export function youtubeIdFromInput(input: string): string | null {
  const raw = input.trim();
  if (YT_ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    id = url.searchParams.get("v");
    const m = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(url.pathname);
    if (!id && m) id = m[1]!;
  }
  return id && YT_ID.test(id) ? id : null;
}

const VIMEO_ID = /^\d{6,12}$/;

/** The numeric Vimeo id from a bare id or a vimeo.com / player.vimeo.com URL (unlisted `/<id>/<hash>` links keep only the id and stay unlisted: they are not supported). */
export function vimeoIdFromInput(input: string): string | null {
  const raw = input.trim();
  if (VIMEO_ID.test(raw)) return raw;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "vimeo.com" && host !== "player.vimeo.com") return null;
  const m = /^\/(?:video\/)?(\d{6,12})(?:\/|$)/.exec(url.pathname);
  if (!m) return null;
  // an unlisted video's link carries a hash segment (/<id>/<hash>): the public player cannot play it without that hash, so refuse it
  if (/^\/(?:video\/)?\d+\/[A-Za-z0-9]+/.test(url.pathname)) return null;
  return m[1]!;
}

/** A third-party video the platform has to moderate before it is shown (maps carry only the block title, which is screened with the other text). */
export interface RemoteEmbedRef {
  provider: "youtube" | "vimeo";
  mediaId: string;
}

/** The moderated reference of an embed source, or null for a map. */
export function remoteEmbedRef(source: EmbedSource): RemoteEmbedRef | null {
  return source.kind === "map" ? null : { provider: source.kind, mediaId: source.videoId };
}

/** Stable key shared by the review table and the renderer. */
export const embedKey = (r: RemoteEmbedRef): string => `${r.provider}:${r.mediaId}`;

/** Every remote video embedded anywhere in the document, de-duplicated. */
export function documentRemoteEmbeds(doc: { pages: { sections: readonly { type: string }[] }[] }): RemoteEmbedRef[] {
  const seen = new Map<string, RemoteEmbedRef>();
  for (const p of doc.pages) for (const s of p.sections) {
    if (s.type !== "embed") continue;
    const r = remoteEmbedRef((s as unknown as { source: EmbedSource }).source);
    if (r) seen.set(embedKey(r), r);
  }
  return [...seen.values()];
}
