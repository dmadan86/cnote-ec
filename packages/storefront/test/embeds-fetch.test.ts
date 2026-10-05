// oEmbed metadata is fetched server-side through the SSRF guards (assertPublicHttpTarget + pinnedFetch); the seller never supplies a URL.
import { afterEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  targets: [] as string[],
  pinned: [] as { url: string; init: unknown }[],
  respond: (() => new Response("{}", { status: 200 })) as () => Response,
  blockTargets: false,
}));
vi.mock("@cnote/security", () => ({
  assertPublicHttpTarget: async (raw: string) => {
    s.targets.push(raw);
    if (s.blockTargets) throw new Error("That URL is not allowed.");
    return { url: new URL(raw), address: "203.0.113.9", family: 4 };
  },
  pinnedFetch: async (t: { url: URL }, init: unknown) => {
    s.pinned.push({ url: t.url.toString(), init });
    return s.respond();
  },
}));
vi.mock("@cnote/ai", () => ({ moderate: async () => ({}) }));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async () => new Map() }));
vi.mock("@cnote/catalogue", () => ({ autoApprovePolicy: () => ({}), mayAutoApprove: () => false }));

import { EmbedFetchError, fetchOembed, oembedUrl, parseOembed, screeningText } from "../src/embeds";

afterEach(() => {
  s.targets.length = 0;
  s.pinned.length = 0;
  s.blockTargets = false;
});

const yt = { provider: "youtube", mediaId: "dQw4w9WgXcQ" } as const;
const vm = { provider: "vimeo", mediaId: "123456789" } as const;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

describe("oEmbed URLs", () => {
  it("are built by the platform on fixed provider hosts from the validated id", () => {
    expect(oembedUrl(yt)).toBe("https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ");
    expect(oembedUrl(vm)).toBe("https://vimeo.com/api/oembed.json?url=https%3A%2F%2Fvimeo.com%2F123456789");
  });
});

describe("parseOembed", () => {
  it("keeps title, channel and description; keeps a thumbnail only from the provider's image host", () => {
    expect(parseOembed("youtube", { title: " Factory tour ", author_name: "Acme", thumbnail_url: "https://i.ytimg.com/vi/x/hqdefault.jpg" })).toEqual({
      title: "Factory tour", authorName: "Acme", description: null, thumbnailUrl: "https://i.ytimg.com/vi/x/hqdefault.jpg",
    });
    expect(parseOembed("vimeo", { title: "t", description: "d", thumbnail_url: "https://i.vimeocdn.com/video/1_640.jpg" }).thumbnailUrl).toBe("https://i.vimeocdn.com/video/1_640.jpg");
    for (const bad of ["https://evil.test/a.jpg", "http://i.ytimg.com/a.jpg", "https://i.ytimg.com.evil.test/a.jpg", "not a url", "javascript:alert(1)"]) {
      expect(parseOembed("youtube", { title: "t", thumbnail_url: bad }).thumbnailUrl, bad).toBeNull();
    }
    expect(parseOembed("youtube", { title: "t", thumbnail_url: "https://i.vimeocdn.com/x.jpg" }).thumbnailUrl).toBeNull(); // another provider's host
  });
  it("rejects a payload without a title", () => {
    expect(() => parseOembed("youtube", { author_name: "x" })).toThrow();
    expect(() => parseOembed("youtube", "nope")).toThrow();
  });
});

describe("fetchOembed", () => {
  it("validates the target with assertPublicHttpTarget, then fetches through the pinned client with a timeout", async () => {
    s.respond = () => json({ title: "Tour", author_name: "Acme", thumbnail_url: "https://i.ytimg.com/vi/a/b.jpg" });
    const meta = await fetchOembed(yt);
    expect(meta).toMatchObject({ title: "Tour", authorName: "Acme" });
    expect(s.targets).toEqual([oembedUrl(yt)]);
    expect(s.pinned).toHaveLength(1);
    expect(s.pinned[0]!.init).toMatchObject({ timeoutMs: 8000 });
  });
  it("a blocked or unresolvable target is a transient fetch error and never reaches the network", async () => {
    s.blockTargets = true;
    await expect(fetchOembed(yt)).rejects.toMatchObject({ name: "EmbedFetchError", permanent: false });
    expect(s.pinned).toHaveLength(0);
  });
  it("404/403/401/410 are permanent (removed or private); other failures and unreadable bodies are transient", async () => {
    for (const status of [404, 403, 401, 410]) {
      s.respond = () => json({}, status);
      await expect(fetchOembed(vm), String(status)).rejects.toMatchObject({ permanent: true });
    }
    s.respond = () => json({}, 503);
    await expect(fetchOembed(vm)).rejects.toMatchObject({ permanent: false, message: expect.stringContaining("503") });
    s.respond = () => new Response("<html>", { status: 200 });
    await expect(fetchOembed(vm)).rejects.toBeInstanceOf(EmbedFetchError);
    s.respond = () => json({ nope: true });
    await expect(fetchOembed(vm)).rejects.toMatchObject({ permanent: false });
  });
});

describe("screeningText", () => {
  it("covers title, channel, description and the thumbnail reference (not its URL)", () => {
    const t = screeningText(yt, { title: "Tour", authorName: "Acme", description: "Our plant", thumbnailUrl: "https://i.ytimg.com/vi/abc/hqdefault.jpg" });
    expect(t).toContain("Title: Tour");
    expect(t).toContain("Channel: Acme");
    expect(t).toContain("Description: Our plant");
    expect(t).toContain("Thumbnail: abc / hqdefault.jpg");
    expect(t).not.toContain("https://");
    expect(screeningText(vm, { title: "t", authorName: null, description: null, thumbnailUrl: null })).toContain("none (not from the provider's image host)");
  });
});
