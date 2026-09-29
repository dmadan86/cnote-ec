import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  verdict: "allow" as "allow" | "review" | "block",
  approvedImages: [] as string[],
  profiles: new Map<string, { businessId: string; name: string; city: string | null; state: string | null; pincode: null; verificationTier: number; trustScore: number; badgeActive: boolean; languages: string[] }>(),
}));

vi.mock("@cnote/ai", async (orig) => ({
  ...(await orig<typeof import("@cnote/ai")>()),
  moderate: async () => ({ verdict: state.verdict, flags: state.verdict === "allow" ? [] : ["prohibited"], reason: state.verdict === "allow" ? null : "looks risky", decisionId: randomUUID(), confidence: 1, needsReview: false }),
}));
vi.mock("@cnote/catalogue", () => ({
  listPublicSellerListings: async () => [],
  listSellerListings: async () => [{ id: "l1", title: "Box", status: "published" }],
  listSellerListingImages: async () => state.approvedImages.map((id) => ({ id, url: `/media/listing-images/${id}`, status: "approved", altText: "x" })),
}));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async (ids: string[]) => new Map(ids.flatMap((i) => (state.profiles.has(i) ? [[i, state.profiles.get(i)!]] : []))) }));
vi.mock("@cnote/reviews", () => ({ getRatingSummaries: async () => new Map(), listApprovedReviews: async () => ({ items: [], nextCursor: null }) }));
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: async () => true }));

import { DomainError } from "@cnote/core";
import {
  applyTemplate, getDraft, getOrCreateStorefront, getPublishedStorefront, listStorefrontReviews, listTemplates, previewDraft, getDraftByPreviewToken, publish, resolveStorefrontBySlug,
  restoreVersion, reviewStorefrontVersion, saveDraft, seedStorefrontTemplates, setSlug, suspendStorefront, reinstateStorefront, listVersions, worker, blankDocument, isSlugAvailable,
} from "../src";

const tag = Math.random().toString(36).slice(2, 8);
const biz = () => {
  const id = randomUUID();
  state.profiles.set(id, { businessId: id, name: `Acme Test ${tag}`, city: "Pune", state: "MH", pincode: null, verificationTier: 1, trustScore: 60, badgeActive: true, languages: ["en"] });
  return id;
};
const created: string[] = [];
const person = randomUUID();
const staff = randomUUID();

beforeEach(() => {
  state.verdict = "allow";
  state.approvedImages = [];
});

afterAll(async () => {
  const sfs = await prisma.storefront.findMany({ where: { sellerBusinessId: { in: created } }, select: { id: true } });
  const ids = sfs.map((s) => s.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.storefront.updateMany({ where: { id: { in: ids } }, data: { publishedVersionId: null } });
  await prisma.storefrontVersion.deleteMany({ where: { storefrontId: { in: ids } } });
  await prisma.storefront.deleteMany({ where: { id: { in: ids } } });
});

const fresh = async () => {
  const b = biz();
  created.push(b);
  return { b, sf: await getOrCreateStorefront(b, person) };
};

describe("storefront lifecycle", () => {
  it("creates once, suggests a unique slug and seeds a valid draft", async () => {
    const { b, sf } = await fresh();
    expect(sf.slug).toContain("acme-test");
    expect((await getOrCreateStorefront(b)).id).toBe(sf.id);
    const b2 = biz();
    created.push(b2);
    const sf2 = await getOrCreateStorefront(b2);
    expect(sf2.slug).not.toBe(sf.slug);
    const d = await getDraft(b);
    expect(d.document.pages[0]!.slug).toBe("home");
    expect(d.hasUnpublishedChanges).toBe(true);
  });

  it("validates and de-duplicates slugs", async () => {
    const { b, sf } = await fresh();
    const other = await fresh();
    await expect(setSlug(b, "www")).rejects.toThrow(DomainError);
    await expect(setSlug(b, "ab")).rejects.toThrow(/3 to 40/);
    await expect(setSlug(b, other.sf.slug)).rejects.toMatchObject({ code: "conflict" });
    const mine = `mine-${tag}-${Math.random().toString(36).slice(2, 6)}`;
    expect((await setSlug(b, mine)).slug).toBe(mine);
    expect(await isSlugAvailable(mine, sf.id)).toBe(true);
    expect(await isSlugAvailable(mine)).toBe(false);
    expect((await resolveStorefrontBySlug(mine))?.id).toBe(sf.id);
  });

  it("autosaves with optimistic concurrency", async () => {
    const { b } = await fresh();
    const d = await getDraft(b);
    const edited = structuredClone(d.document);
    edited.pages[0]!.title = "Start";
    const s1 = await saveDraft(b, person, edited, d.etag);
    expect(s1.etag).not.toBe(d.etag);
    const other = structuredClone(d.document);
    other.pages[0]!.title = "Other tab";
    await expect(saveDraft(b, person, other, d.etag)).rejects.toMatchObject({ code: "conflict" });
    await expect(saveDraft(b, person, { nope: 1 }, s1.etag)).rejects.toMatchObject({ code: "validation" });
    expect((await saveDraft(b, person, other, s1.etag)).etag).not.toBe(s1.etag);
  });

  it("applies a template with the seller's real data and keeps the old draft in history", async () => {
    const { b } = await fresh();
    await seedStorefrontTemplates();
    expect((await listTemplates()).length).toBeGreaterThanOrEqual(6);
    const before = (await listVersions(b)).length;
    const d = await applyTemplate(b, person, "industrial-classic");
    expect(JSON.stringify(d.document)).toContain(`Acme Test ${tag}`);
    expect(JSON.stringify(d.document)).not.toContain("{{");
    expect(d.storefront.templateKey).toBe("industrial-classic");
    expect((await listVersions(b)).length).toBe(before + 1);
    await expect(applyTemplate(b, person, "nope")).rejects.toMatchObject({ code: "not_found" });
    const restored = await restoreVersion(b, person, (await listVersions(b)).at(-1)!.id);
    expect(restored.document.pages).toHaveLength(1);
  });

  it("publishes clean content live and serves it from getPublishedStorefront", async () => {
    const { b, sf } = await fresh();
    expect(await getPublishedStorefront(sf.slug)).toBeNull();
    const r = await publish(b, person);
    expect(r.outcome).toBe("published");
    const live = await getPublishedStorefront(sf.slug);
    expect(live?.storefront.sellerBusinessId).toBe(b);
    expect(live?.data.trust.gstVerified).toBe(true);
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: sf.id, type: "StorefrontPublished" } });
    expect(ev).toHaveLength(1);
    const d = await getDraft(b);
    expect(d.draft.id).not.toBe(r.versionId);
    expect(d.hasUnpublishedChanges).toBe(false);
  });

  it("holds flagged content for staff review and never auto-publishes it", async () => {
    const { b, sf } = await fresh();
    state.verdict = "review";
    const r = await publish(b, person);
    expect(r.outcome).toBe("in_review");
    expect(await getPublishedStorefront(sf.slug)).toBeNull();
    const q = await listStorefrontReviews();
    const item = q.find((i) => i.versionId === r.versionId)!;
    expect(item.aiVerdict).toContain("review");
    await expect(reviewStorefrontVersion(r.versionId, staff, "rejected", " ")).rejects.toMatchObject({ code: "validation" });
    const ok = await reviewStorefrontVersion(r.versionId, staff, "approved");
    expect(ok.status).toBe("published");
    expect((await getPublishedStorefront(sf.slug))?.storefront.versionId).toBe(r.versionId);
    await expect(reviewStorefrontVersion(r.versionId, staff, "approved")).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects a flagged version with a note the seller can see", async () => {
    const { b } = await fresh();
    state.verdict = "block";
    const r = await publish(b, person);
    expect(r.outcome).toBe("in_review");
    await reviewStorefrontVersion(r.versionId, staff, "rejected", "Contains prohibited claims.");
    const d = await getDraft(b);
    expect(d.lastRejection?.note).toBe("Contains prohibited claims.");
  });

  it("refuses unapproved images at publish and accepts approved ones", async () => {
    const { b } = await fresh();
    const imgId = randomUUID();
    const d = await getDraft(b);
    const doc = structuredClone(d.document);
    doc.theme.logo = { src: `/media/listing-images/${imgId}`, alt: "Logo" };
    await saveDraft(b, person, doc, d.etag);
    await expect(publish(b, person)).rejects.toMatchObject({ code: "validation" });
    state.approvedImages = [imgId];
    expect((await publish(b, person)).outcome).toBe("published");
  });

  it("suspends and reinstates; suspended storefronts cannot publish", async () => {
    const { b, sf } = await fresh();
    await publish(b, person);
    expect(await getPublishedStorefront(sf.slug)).not.toBeNull();
    await expect(suspendStorefront(sf.id, staff, "")).rejects.toMatchObject({ code: "validation" });
    await suspendStorefront(sf.id, staff, "Policy violation");
    expect(await getPublishedStorefront(sf.slug)).toBeNull();
    await expect(publish(b, person)).rejects.toMatchObject({ code: "forbidden" });
    await reinstateStorefront(sf.id);
    expect(await getPublishedStorefront(sf.slug)).not.toBeNull();
  });

  it("issues preview tokens that render the current draft", async () => {
    const { b } = await fresh();
    const { token } = await previewDraft(b);
    const p = await getDraftByPreviewToken(token);
    expect(p.document.pages[0]!.slug).toBe("home");
    await expect(getDraftByPreviewToken(`${token}x`)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("worker handlers purge without throwing for unknown sellers", async () => {
    await expect(worker.handlers.TrustScoreChanged!({ payload: { businessId: randomUUID() } } as never)).resolves.toBeUndefined();
    expect(Object.keys(worker.handlers)).toEqual(expect.arrayContaining(["StorefrontPublished", "ListingModerated", "ReviewModerated"]));
    expect(blankDocument({ name: "x", city: null }).schemaVersion).toBe(1);
  });
});
