import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { blankDocument, collectText, documentHasEmbeds, documentRemoteEmbeds, embedKey, embedsEnabled, defaultSection, EMBED_FRAME_ORIGINS, embedSourceSchema, embedSpec, newSectionId, remoteEmbedRef, sectionSchema, validateDocument, vimeoIdFromInput, youtubeIdFromInput, type StorefrontDocument } from "../src/document";
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
  approvedEmbeds: [`youtube:${ID}`, "vimeo:123456789"],
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
    expect(embedSourceSchema.safeParse({ kind: "vimeo", videoId: "123456789" }).success).toBe(true);
    expect(embedSourceSchema.safeParse({ kind: "map", lat: 18.52, lng: 73.85, zoom: 14 }).success).toBe(true);
    for (const bad of [
      { kind: "youtube", videoId: "short" },
      { kind: "youtube", videoId: `${ID}12` },
      { kind: "youtube", videoId: "https://evil.test/x" },
      { kind: "youtube", videoId: ID, src: "https://evil.test" },
      { kind: "vimeo", videoId: "12345" },
      { kind: "vimeo", videoId: "abc123456" },
      { kind: "vimeo", videoId: "https://vimeo.com/123456789" },
      { kind: "dailymotion", videoId: "x7tgad0" },
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

  it("Vimeo: privacy-enhanced player URL (dnt=1) on the allow-listed origin, marketing consent", () => {
    const v = embedSpec({ kind: "vimeo", videoId: "123456789" });
    expect(v).toMatchObject({ kind: "vimeo", provider: "Vimeo", category: "marketing", href: "https://vimeo.com/123456789", src: "https://player.vimeo.com/video/123456789?dnt=1" });
    expect(EMBED_FRAME_ORIGINS.some((o) => v.src.startsWith(`${o}/`))).toBe(true);
  });

  it("extracts a Vimeo id from a pasted link, refusing other hosts, look-alikes and unlisted (hash) links", () => {
    for (const ok of ["123456789", " 123456789 ", "https://vimeo.com/123456789", "vimeo.com/123456789", "https://www.vimeo.com/123456789?share=copy", "https://player.vimeo.com/video/123456789"]) {
      expect(vimeoIdFromInput(ok), ok).toBe("123456789");
    }
    for (const bad of ["", "12345", "https://vimeo.com/", "https://vimeo.com/channels/staffpicks/123456789", "https://vimeo.com/123456789/abcdef1234", "https://notvimeo.com/123456789", "https://vimeo.com.evil.test/123456789", "https://youtube.com/watch?v=dQw4w9WgXcQ", "http://[bad"]) {
      expect(vimeoIdFromInput(bad), bad).toBeNull();
    }
  });

  it("lists the remote videos in a document once each; maps are not moderated", () => {
    const d = doc({ kind: "youtube", videoId: ID });
    d.pages[0]!.sections.push({ id: "e2", type: "embed", tone: "default", title: "Again", source: { kind: "youtube", videoId: ID } } as never);
    d.pages[0]!.sections.push({ id: "e3", type: "embed", tone: "default", title: "Tour", source: { kind: "vimeo", videoId: "123456789" } } as never);
    d.pages[0]!.sections.push({ id: "e4", type: "embed", tone: "default", title: "Map", source: { kind: "map", lat: 1, lng: 1, zoom: 5 } } as never);
    expect(documentRemoteEmbeds(d).map(embedKey)).toEqual([`youtube:${ID}`, "vimeo:123456789"]);
    expect(remoteEmbedRef({ kind: "map", lat: 1, lng: 1, zoom: 5 })).toBeNull();
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
  const render = (d: StorefrontDocument, Embed?: (p: EmbedProps) => React.ReactNode, embedsEnabled = true) => renderToStaticMarkup(<StorefrontView document={d} data={data} hrefs={hrefs} Embed={Embed} embedsEnabled={embedsEnabled} />);

  it("renders nothing for a stored embed block while STOREFRONT_EMBEDS_ENABLED is off (no heading, no link, no frame)", () => {
    const html = render(doc({ kind: "youtube", videoId: ID }), () => <span data-embed="x" />, false);
    expect(html).not.toMatch(/Our workshop|data-embed|youtube|class="sf-embed"|id="sf-h-e1"/);
    expect(render(doc({ kind: "youtube", videoId: ID }), undefined, false)).not.toContain("open on YouTube");
  });
  it("the default follows the server env flag (off unless 1 / true)", () => {
    const d = doc({ kind: "youtube", videoId: ID });
    expect(renderToStaticMarkup(<StorefrontView document={d} data={data} hrefs={hrefs} />)).not.toContain("Our workshop");
    vi.stubEnv("STOREFRONT_EMBEDS_ENABLED", "true");
    expect(renderToStaticMarkup(<StorefrontView document={d} data={data} hrefs={hrefs} />)).toContain("Our workshop");
    vi.unstubAllEnvs();
  });
  it("embedsEnabled / documentHasEmbeds", () => {
    expect([undefined, "", "0", "false", "yes"].map((v) => embedsEnabled({ STOREFRONT_EMBEDS_ENABLED: v }))).toEqual([false, false, false, false, false]);
    expect([embedsEnabled({ STOREFRONT_EMBEDS_ENABLED: "1" }), embedsEnabled({ STOREFRONT_EMBEDS_ENABLED: "TRUE" })]).toEqual([true, true]);
    expect(documentHasEmbeds(doc({ kind: "youtube", videoId: ID }))).toBe(true);
    expect(documentHasEmbeds(blankDocument({ name: "A", city: null }))).toBe(false);
  });
  it("by default renders NO third-party frame: only a link the visitor chooses to follow", () => {
    const html = render(doc({ kind: "youtube", videoId: ID }));
    expect(html).not.toMatch(/<iframe/i);
    expect(html).toContain(`href="https://www.youtube.com/watch?v=${ID}"`);
    expect(html).toContain("Our workshop: open on YouTube");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).not.toContain("youtube-nocookie");
  });

  it("a third-party video that is not approved is not rendered at all; in the editor preview the seller is told it is waiting", () => {
    const d = doc({ kind: "youtube", videoId: ID });
    const pending = { ...data, approvedEmbeds: [] };
    const view = (dd: RenderData, preview = false) => renderToStaticMarkup(<StorefrontView document={d} data={dd} hrefs={hrefs} embedsEnabled preview={preview} />);
    expect(view(pending)).not.toMatch(/Our workshop|class="sf-embed"|youtube\.com/);
    expect(view({ ...data, approvedEmbeds: undefined })).not.toMatch(/Our workshop|class="sf-embed"|youtube\.com/); // fail closed
    expect(view({ ...data, approvedEmbeds: ["youtube:other-id01"] })).not.toContain("Our workshop");
    expect(view(pending, true)).toContain("waiting for approval");
    expect(view(data)).toContain("Our workshop");
  });
  it("maps need no approval", () => {
    const html = renderToStaticMarkup(<StorefrontView document={doc({ kind: "map", lat: 18.52, lng: 73.85, zoom: 14 })} data={{ ...data, approvedEmbeds: [] }} hrefs={hrefs} embedsEnabled />);
    expect(html).toContain("Our workshop");
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
