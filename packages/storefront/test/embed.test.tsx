import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { blankDocument, collectText, defaultSection, EMBED_FRAME_ORIGINS, embedSourceSchema, embedSpec, newSectionId, sectionSchema, validateDocument, youtubeIdFromInput, type StorefrontDocument } from "../src/document";
import { StorefrontView } from "../src/render/view";
import type { EmbedProps, RenderData } from "../src/render/types";

const ID = "dQw4w9WgXcQ";
const data: RenderData = {
  business: { id: "b1", name: "Acme", city: "Pune", state: "MH" },
  trust: { tier: 2, score: 70, badgeActive: true, gstVerified: true },
  rating: null,
  products: [],
  categories: [],
  testimonials: [],
};
const hrefs = { page: (s: string) => `/store/acme/${s}`, product: (p: { id: string }) => `/p/${p.id}`, rfq: "/rfq?seller=b1" };
const doc = (source: unknown): StorefrontDocument => {
  const d = blankDocument({ name: "Acme", city: "Pune" });
  d.pages[0]!.sections.push({ id: "e1", type: "embed", tone: "default", title: "Our workshop", source } as never);
  return d;
};

describe("embed sources", () => {
  it("accepts a YouTube id or a map, and nothing else (no URLs, no HTML, no other providers)", () => {
    expect(embedSourceSchema.safeParse({ kind: "youtube", videoId: ID }).success).toBe(true);
    expect(embedSourceSchema.safeParse({ kind: "map", lat: 18.52, lng: 73.85, zoom: 14 }).success).toBe(true);
    for (const bad of [
      { kind: "youtube", videoId: "short" },
      { kind: "youtube", videoId: `${ID}12` },
      { kind: "youtube", videoId: "https://evil.test/x" },
      { kind: "youtube", videoId: ID, src: "https://evil.test" },
      { kind: "iframe", src: "https://evil.test" },
      { kind: "map", lat: 91, lng: 0, zoom: 5 },
      { kind: "map", lat: 0, lng: 181, zoom: 5 },
      { kind: "map", lat: 0, lng: 0, zoom: 2 },
      { kind: "map", lat: 0, lng: 0, zoom: 19 },
      { kind: "map", lat: 0, lng: 0, zoom: 5.5 },
      { kind: "map", lat: "18", lng: 73, zoom: 5 },
    ]) expect(embedSourceSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it("builds privacy-enhanced URLs on the fixed origins, with the consent category per provider", () => {
    const yt = embedSpec({ kind: "youtube", videoId: ID });
    expect(yt).toMatchObject({ kind: "youtube", provider: "YouTube", category: "marketing", href: `https://www.youtube.com/watch?v=${ID}` });
    expect(yt.src).toBe(`https://www.youtube-nocookie.com/embed/${ID}?rel=0`);
    const map = embedSpec({ kind: "map", lat: 18.52, lng: 73.85, zoom: 14 });
    expect(map).toMatchObject({ kind: "map", provider: "OpenStreetMap", category: "functional" });
    expect(map.src).toMatch(/^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=[\d.%C-]+&layer=mapnik&marker=18\.52%2C73\.85$/);
    expect(map.href).toBe("https://www.openstreetmap.org/?mlat=18.52&mlon=73.85#map=14/18.52/73.85");
    for (const s of [yt.src, map.src]) expect(EMBED_FRAME_ORIGINS.some((o) => s.startsWith(`${o}/`))).toBe(true);
    // the bounding box is around the point, west < east and south < north
    const [w, s, e, n] = decodeURIComponent(/bbox=([^&]+)/.exec(map.src)![1]!).split(",").map(Number) as [number, number, number, number];
    expect(w).toBeLessThan(73.85);
    expect(e).toBeGreaterThan(73.85);
    expect(s).toBeLessThan(18.52);
    expect(n).toBeGreaterThan(18.52);
  });

  it("extracts the video id from what a seller pastes, and rejects other hosts and look-alikes", () => {
    for (const ok of [ID, ` ${ID} `, `https://www.youtube.com/watch?v=${ID}&t=5`, `youtube.com/watch?v=${ID}`, `https://m.youtube.com/watch?v=${ID}`, `https://youtu.be/${ID}?si=x`, `https://www.youtube.com/embed/${ID}`, `https://www.youtube-nocookie.com/embed/${ID}`, `https://www.youtube.com/shorts/${ID}`, `https://www.youtube.com/live/${ID}`]) {
      expect(youtubeIdFromInput(ok), ok).toBe(ID);
    }
    for (const bad of ["", "not a url", "https://vimeo.com/123456789", `https://youtube.evil.test/watch?v=${ID}`, `https://evil.test/?v=${ID}`, "https://www.youtube.com/watch?v=short", "https://youtu.be/", "https://www.youtube.com/", "http://[bad"]) {
      expect(youtubeIdFromInput(bad), bad).toBeNull();
    }
  });
});

describe("embed block in the document", () => {
  it("validates, has a harmless default, a label and a moderation text, and gets a fresh id", () => {
    expect(validateDocument(doc({ kind: "youtube", videoId: ID })).ok).toBe(true);
    expect(validateDocument(doc({ kind: "youtube", videoId: "nope" })).ok).toBe(false);
    const dflt = defaultSection("embed", "e2");
    expect(sectionSchema.safeParse(dflt).success).toBe(true);
    expect(newSectionId("embed", ["embed-1"])).toBe("embed-2");
    expect(collectText(doc({ kind: "youtube", videoId: ID }))).toContain("Our workshop");
  });
  it("requires a title so the frame has an accessible name", () => {
    const d = doc({ kind: "youtube", videoId: ID });
    (d.pages[0]!.sections.at(-1) as { title: string }).title = "";
    expect(validateDocument(d).ok).toBe(false);
  });
});

describe("embed block rendering", () => {
  const render = (d: StorefrontDocument, Embed?: (p: EmbedProps) => React.ReactNode) => renderToStaticMarkup(<StorefrontView document={d} data={data} hrefs={hrefs} Embed={Embed} />);

  it("by default renders NO third-party frame: only a link the visitor chooses to follow", () => {
    const html = render(doc({ kind: "youtube", videoId: ID }));
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain(`href="https://www.youtube.com/watch?v=${ID}"`);
    expect(html).toContain("Our workshop: open on YouTube");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain("youtube-nocookie");
  });

  it("hands the host the spec (privacy-enhanced src, provider, category, accessible title) and puts it in a titled section", () => {
    const seen: EmbedProps[] = [];
    const html = render(doc({ kind: "map", lat: 18.52, lng: 73.85, zoom: 14 }), (p) => {
      seen.push(p);
      return <span data-embed={p.kind} />;
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "map", provider: "OpenStreetMap", category: "functional", title: "Our workshop" });
    expect(seen[0]!.src.startsWith("https://www.openstreetmap.org/export/embed.html?")).toBe(true);
    expect(html).toContain('<div class="sf-embed"><span data-embed="map"></span></div>');
    expect(html).toMatch(/<section aria-labelledby="sf-h-e1"/);
  });
});
