// Third-party embeds in a storefront (the `embed` block): a closed set of providers, never a seller-supplied URL or HTML.
// The seller picks a provider and gives an id / coordinates; the platform builds the iframe URL itself from a fixed, privacy-enhanced
// host (youtube-nocookie.com, openstreetmap.org), so an embed can only ever point at these origins. The renderer hands the result to
// an `Embed` component, which in the buyer web is wrapped in <ConsentGate>: nothing from the provider loads (no request, no cookie)
// until the visitor allows the category or chooses "Load it" for that item (DPDP s.6; ePrivacy Art 5(3); docs/design/cookie-consent.md).
import { z } from "zod";

/** Origins an embed iframe may use. The buyer web's CSP `frame-src` must allow exactly these (see packages/security csp.ts and its test). */
export const EMBED_FRAME_ORIGINS = ["https://www.youtube-nocookie.com", "https://www.openstreetmap.org"] as const;

export type EmbedCategory = "marketing" | "functional";
export type EmbedKind = "youtube" | "map";

export const embedSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("youtube"), videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "Use an 11-character YouTube video id.") }),
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
