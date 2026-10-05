// Embed moderation pipeline: oEmbed metadata -> ai.moderate -> pending / auto-approve / reject, staff review, re-check.
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  verdict: "allow" as "allow" | "review" | "block",
  deterministic: "clean" as "clean" | "review" | "block",
  needsReview: false,
  moderationThrows: false,
  moderated: [] as string[],
  meta: { title: "Factory tour", authorName: "Acme Steel", description: "Our plant in Pune", thumbnailUrl: "https://i.ytimg.com/vi/a/hq.jpg" as string | null },
  fetchThrows: null as null | { message: string; permanent: boolean },
  fetchCalls: 0,
  profile: { verificationTier: 1, trustScore: 70, createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString() } as { verificationTier: number; trustScore: number; createdAt?: string },
  purged: [] as string[][],
  purgeThrows: false,
}));

vi.mock("@cnote/ai", async (orig) => ({
  ...(await orig<typeof import("@cnote/ai")>()),
  moderate: async (input: { text: string }) => {
    state.moderated.push(input.text);
    if (state.moderationThrows) throw new Error("model down");
    return {
      verdict: state.verdict, flags: state.verdict === "allow" ? [] : ["counterfeit"], reason: state.verdict === "allow" ? null : "looks risky", deterministic: state.deterministic,
      decisionId: randomUUID(), confidence: 0.95, needsReview: state.needsReview,
    };
  },
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.map((i) => [i, { businessId: i, name: "Acme", city: null, state: null, pincode: null, languages: [], badgeActive: true, ...state.profile }])),
}));
vi.mock("../src/cache", async (orig) => ({ ...(await orig<typeof import("../src/cache")>()), purgeStorefront: async (slugs: string[]) => { if (state.purgeThrows) throw new Error("cache down"); state.purged.push(slugs); } }));

import { documentRemoteEmbeds, blankDocument } from "../src/document";
import {
  approvedEmbedKeys, embedStatusesForSeller, ensureEmbedReviews, EmbedFetchError, listEmbedReviews, recheckEmbeds, reviewEmbed, setOembedFetcherForTests,
} from "../src/embeds";

const tag = randomUUID().slice(0, 8);
const created: { sf: string; biz: string }[] = [];
const staff = randomUUID();
const VID = "dQw4w9WgXcQ";

async function storefront() {
  const biz = randomUUID();
  const sf = await prisma.storefront.create({ data: { sellerBusinessId: biz, slug: `emb-${tag}-${created.length}` } });
  created.push({ sf: sf.id, biz });
  return { id: sf.id, slug: sf.slug, sellerBusinessId: biz };
}
const docWith = (...sources: unknown[]) => {
  const d = blankDocument({ name: "Acme", city: "Pune" });
  sources.forEach((source, i) => d.pages[0]!.sections.push({ id: `e${i}`, type: "embed", tone: "default", title: `Video ${i}`, source } as never));
  return d;
};
const yt = (id = VID) => ({ kind: "youtube", videoId: id });
const row = (sfId: string, mediaId = VID, provider = "youtube") => prisma.storefrontEmbedReview.findUniqueOrThrow({ where: { storefrontId_provider_mediaId: { storefrontId: sfId, provider, mediaId } } });
/** three staff-approved embeds = the seller's history for the listing-style auto-approval gate */
async function history(sfId: string, n = 3) {
  for (let i = 0; i < n; i++) await prisma.storefrontEmbedReview.create({ data: { storefrontId: sfId, provider: "youtube", mediaId: `hist${i}${tag}`.slice(0, 11).padEnd(11, "x"), status: "approved", decidedBy: "staff" } });
}

beforeEach(() => {
  vi.stubEnv("LISTING_AUTO_APPROVE_SAMPLE_RATE", "0");
  state.verdict = "allow"; state.deterministic = "clean"; state.needsReview = false; state.moderationThrows = false; state.moderated = [];
  state.meta = { title: "Factory tour", authorName: "Acme Steel", description: "Our plant in Pune", thumbnailUrl: "https://i.ytimg.com/vi/a/hq.jpg" };
  state.fetchThrows = null; state.fetchCalls = 0; state.purged = []; state.purgeThrows = false;
  state.profile = { verificationTier: 1, trustScore: 70, createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString() };
  setOembedFetcherForTests(async () => {
    state.fetchCalls++;
    if (state.fetchThrows) throw new EmbedFetchError(state.fetchThrows.message, state.fetchThrows.permanent);
    return { ...state.meta };
  });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  setOembedFetcherForTests(undefined);
  const ids = created.map((c) => c.sf);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.storefrontEmbedReview.deleteMany({ where: { storefrontId: { in: ids } } });
  await prisma.storefront.deleteMany({ where: { id: { in: ids } } });
});

describe("ensureEmbedReviews", () => {
  it("a new seller's video is held in pending (not shown), the metadata is stored and screened as one text", async () => {
    state.profile = { verificationTier: 0, trustScore: 10 };
    const sf = await storefront();
    const r = await ensureEmbedReviews(sf, docWith(yt()));
    expect(r.held).toEqual([{ provider: "youtube", mediaId: VID }]);
    expect(r.approved).toEqual([]);
    const db = await row(sf.id);
    expect(db).toMatchObject({ status: "pending", title: "Factory tour", authorName: "Acme Steel", aiVerdict: "allow", decidedBy: null, fetchError: null });
    expect(db.aiDecisionId).toBeTruthy();
    expect(state.moderated).toHaveLength(1);
    expect(state.moderated[0]).toMatch(/Title: Factory tour[\s\S]*Channel: Acme Steel[\s\S]*Description: Our plant in Pune[\s\S]*Thumbnail: /);
    expect(await approvedEmbedKeys(sf.sellerBusinessId)).toEqual([]);
    expect((await listEmbedReviews()).some((i) => i.id === db.id && i.href === `https://www.youtube.com/watch?v=${VID}`)).toBe(true);
  });

  it("auto-approves only under the listing strictness rules: clean pre-check + model allow + tier/trust + account age + staff-approved history", async () => {
    const sf = await storefront();
    await history(sf.id);
    const r = await ensureEmbedReviews(sf, docWith(yt()));
    expect(r.approved).toEqual([{ provider: "youtube", mediaId: VID }]);
    const db = await row(sf.id);
    expect(db).toMatchObject({ status: "approved", decidedBy: "auto" });
    expect(db.nextCheckAt).toBeInstanceOf(Date);
    expect(await approvedEmbedKeys(sf.sellerBusinessId)).toContain(`youtube:${VID}`);
    expect(state.purged.flat()).toContain(sf.slug);
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: sf.id, type: "StorefrontEmbedDecided" } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ status: "approved", decidedBy: "auto", provider: "youtube", mediaId: VID });
  });

  it.each([
    ["tier 0", { verificationTier: 0, trustScore: 70, createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString() }, {}],
    ["low trust", { verificationTier: 1, trustScore: 10, createdAt: new Date(Date.now() - 400 * 86_400_000).toISOString() }, {}],
    ["young account", { verificationTier: 1, trustScore: 70, createdAt: new Date().toISOString() }, {}],
    ["no staff-approved history", undefined, { noHistory: true }],
    ["deterministic pre-check says review", undefined, { deterministic: "review" as const }],
    ["model asks for review", undefined, { needsReview: true }],
    ["screening unavailable", undefined, { throws: true }],
    ["thumbnail not from the provider's image host", undefined, { thumbnail: null }],
  ])("stays pending when: %s", async (_name, profile, o: { noHistory?: boolean; deterministic?: "review"; needsReview?: boolean; throws?: boolean; thumbnail?: null }) => {
    if (profile) state.profile = profile;
    if (o.deterministic) state.deterministic = o.deterministic;
    if (o.needsReview) state.needsReview = true;
    if (o.throws) { state.moderationThrows = true; vi.spyOn(console, "error").mockImplementation(() => undefined); }
    if (o.thumbnail === null) state.meta.thumbnailUrl = null;
    const sf = await storefront();
    if (!o.noHistory) await history(sf.id);
    await ensureEmbedReviews(sf, docWith(yt()));
    expect((await row(sf.id)).status).toBe("pending");
    vi.restoreAllMocks();
  });

  it("a sampled share of would-be auto-approvals waits for staff (audit)", async () => {
    vi.stubEnv("LISTING_AUTO_APPROVE_SAMPLE_RATE", "1");
    const sf = await storefront();
    await history(sf.id);
    await ensureEmbedReviews(sf, docWith(yt()));
    expect((await row(sf.id)).status).toBe("pending");
  });

  it("a block verdict rejects outright, with the reason for the seller", async () => {
    state.verdict = "block";
    const sf = await storefront();
    await history(sf.id);
    const r = await ensureEmbedReviews(sf, docWith(yt()));
    expect(r.held).toHaveLength(1);
    expect(await row(sf.id)).toMatchObject({ status: "rejected", decidedBy: "auto", reviewNote: "looks risky" });
    expect(await embedStatusesForSeller(sf.sellerBusinessId)).toContainEqual({ key: `youtube:${VID}`, status: "rejected", note: "looks risky" });
  });

  it("a failed oEmbed fetch leaves it pending with the error (never approved without metadata)", async () => {
    state.fetchThrows = { message: "The provider answered 503.", permanent: false };
    const sf = await storefront();
    await history(sf.id);
    await ensureEmbedReviews(sf, docWith(yt()));
    expect(await row(sf.id)).toMatchObject({ status: "pending", fetchError: "The provider answered 503.", title: null });
    expect(state.moderated).toHaveLength(0);
  });

  it("reviews each distinct video once, handles Vimeo, ignores maps and is idempotent (staff decisions stand)", async () => {
    state.profile = { verificationTier: 0, trustScore: 0 };
    const sf = await storefront();
    const doc = docWith(yt(), yt(), { kind: "vimeo", videoId: "123456789" }, { kind: "map", lat: 1, lng: 1, zoom: 5 });
    expect(documentRemoteEmbeds(doc)).toHaveLength(2);
    await ensureEmbedReviews(sf, doc);
    expect(state.fetchCalls).toBe(2);
    const first = await row(sf.id);
    await reviewEmbed(first.id, staff, "approved", "ok");
    const again = await ensureEmbedReviews(sf, doc);
    expect(state.fetchCalls).toBe(2); // not re-fetched
    expect(again.approved).toEqual([{ provider: "youtube", mediaId: VID }]);
    expect(again.held).toEqual([{ provider: "vimeo", mediaId: "123456789" }]);
    expect(await prisma.storefrontEmbedReview.count({ where: { storefrontId: sf.id } })).toBe(2);
  });
});

describe("staff review (ops queue)", () => {
  it("approve shows the video, reject needs a note the seller can read, both emit an event and purge the page", async () => {
    state.profile = { verificationTier: 0, trustScore: 0 };
    const sf = await storefront();
    await ensureEmbedReviews(sf, docWith(yt(), yt("abcdefghijk")));
    const a = await row(sf.id), b = await row(sf.id, "abcdefghijk");
    await expect(reviewEmbed(b.id, staff, "rejected")).rejects.toMatchObject({ code: "validation" });
    await expect(reviewEmbed(randomUUID(), staff, "approved")).rejects.toMatchObject({ code: "not_found" });
    state.purged = [];
    const ok = await reviewEmbed(a.id, staff, "approved", "Looks fine");
    expect(ok).toMatchObject({ status: "approved", decidedBy: "staff" });
    await reviewEmbed(b.id, staff, "rejected", "Shows a counterfeit brand");
    expect(state.purged.flat()).toContain(sf.slug);
    expect(await approvedEmbedKeys(sf.sellerBusinessId)).toEqual([`youtube:${VID}`]);
    expect(await embedStatusesForSeller(sf.sellerBusinessId)).toEqual(expect.arrayContaining([
      { key: `youtube:${VID}`, status: "approved", note: "Looks fine" }, { key: "youtube:abcdefghijk", status: "rejected", note: "Shows a counterfeit brand" },
    ]));
    const events = await prisma.domainEvent.findMany({ where: { aggregateId: sf.id, type: "StorefrontEmbedDecided" } });
    expect(events.map((e) => (e.payload as { status: string }).status).sort()).toEqual(["approved", "rejected"]);
  });
});

describe("recheckEmbeds", () => {
  const due = async (sfId: string, mediaId = VID) => prisma.storefrontEmbedReview.update({ where: { storefrontId_provider_mediaId: { storefrontId: sfId, provider: "youtube", mediaId } }, data: { nextCheckAt: new Date(Date.now() - 1000) } });

  async function approved() {
    state.profile = { verificationTier: 0, trustScore: 0 };
    const sf = await storefront();
    await ensureEmbedReviews(sf, docWith(yt()));
    await reviewEmbed((await row(sf.id)).id, staff, "approved");
    await due(sf.id);
    return sf;
  }

  it("keeps a still-clean approved video and schedules the next check", async () => {
    const sf = await approved();
    const r = await recheckEmbeds();
    expect(r.rechecked).toBeGreaterThanOrEqual(1);
    const db = await row(sf.id);
    expect(db.status).toBe("approved");
    expect(db.nextCheckAt!.getTime()).toBeGreaterThan(Date.now() + 5 * 86_400_000);
  });

  it("a video whose content now blocks is rejected; one that now needs review is hidden until staff look again", async () => {
    const blocked = await approved();
    state.verdict = "block";
    await recheckEmbeds();
    expect((await row(blocked.id)).status).toBe("rejected");

    state.verdict = "allow";
    const review = await approved();
    state.verdict = "review";
    await recheckEmbeds();
    expect(await row(review.id)).toMatchObject({ status: "pending", reviewNote: "Changed after approval; needs a new check." });
    expect(await approvedEmbedKeys(review.sellerBusinessId)).toEqual([]);
  });

  it("a provider outage does not hide an approved video, but a removed/private one is hidden", async () => {
    const sf = await approved();
    state.fetchThrows = { message: "The provider answered 503.", permanent: false };
    await recheckEmbeds();
    expect(await row(sf.id)).toMatchObject({ status: "approved", fetchError: "The provider answered 503." });

    await due(sf.id);
    state.fetchThrows = { message: "The video is not available (404).", permanent: true };
    await recheckEmbeds();
    expect(await row(sf.id)).toMatchObject({ status: "pending", fetchError: "The video is not available (404)." });
  });

  it("retries a pending embed whose first fetch failed and then decides it", async () => {
    const sf = await storefront();
    await history(sf.id);
    state.fetchThrows = { message: "timeout", permanent: false };
    await ensureEmbedReviews(sf, docWith(yt()));
    expect((await row(sf.id)).status).toBe("pending");
    state.fetchThrows = null;
    await prisma.storefrontEmbedReview.updateMany({ where: { storefrontId: sf.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
    const r = await recheckEmbeds();
    expect(r.retried).toBeGreaterThanOrEqual(1);
    expect(await row(sf.id)).toMatchObject({ status: "approved", fetchError: null, title: "Factory tour" });
  });

  it("is bounded per tick and survives one failing row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sf = await approved();
    expect((await recheckEmbeds({ limit: 1 })).rechecked).toBeLessThanOrEqual(1);
    await due(sf.id);
    state.moderationThrows = true;
    await expect(recheckEmbeds()).resolves.toBeTruthy();
    vi.restoreAllMocks();
  });

  it("logs and moves on when an embed's decision cannot be written (retry and re-check paths), and still counts the rows", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sf = await storefront();
    await history(sf.id);
    state.fetchThrows = { message: "timeout", permanent: false };
    await ensureEmbedReviews(sf, docWith(yt()));
    state.fetchThrows = null;
    await prisma.storefrontEmbedReview.updateMany({ where: { storefrontId: sf.id }, data: { nextCheckAt: new Date(Date.now() - 1000) } });
    const tx = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("db down"));
    const r = await recheckEmbeds({ limit: 100 });
    expect(r.retried).toBeGreaterThanOrEqual(1);
    expect(err.mock.calls.some((c) => String(c[0]).includes("embed retry failed"))).toBe(true);
    tx.mockRestore();

    const ok = await approved();
    const tx2 = vi.spyOn(prisma, "$transaction").mockRejectedValue(new Error("db down"));
    await recheckEmbeds({ limit: 100 });
    expect(err.mock.calls.some((c) => String(c[0]).includes("embed recheck failed"))).toBe(true);
    tx2.mockRestore();
    expect((await row(ok.id)).status).toBe("approved");
    err.mockRestore();
  });

  it("a cache purge failure after a decision is swallowed", async () => {
    const sf = await approved();
    state.purgeThrows = true;
    state.verdict = "block";
    await recheckEmbeds({ limit: 100 });
    expect((await row(sf.id)).status).toBe("rejected");
  });
});
