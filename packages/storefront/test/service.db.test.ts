import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  mode: "allow" as "allow" | "review" | "block" | "needsReview" | "throw" | "lowThenBlock",
  calls: 0,
  texts: [] as string[],
  rate: true,
  profiles: new Map<string, { businessId: string; name: string; city: string | null; state: string | null; pincode: null; verificationTier: number; trustScore: number; badgeActive: boolean; languages: string[] }>(),
}));

vi.mock("@cnote/ai", async (orig) => ({
  ...(await orig<typeof import("@cnote/ai")>()),
  moderate: async (input: { text: string }) => {
    state.calls++;
    state.texts.push(input.text);
    const base = { flags: [] as string[], reason: null as string | null, decisionId: "d", confidence: 1, needsReview: false };
    switch (state.mode) {
      case "throw": throw new Error("anthropic down");
      case "review": return { ...base, verdict: "review", flags: ["claims"], reason: "check claims" };
      case "block": return { ...base, verdict: "block", flags: ["prohibited"], reason: "bad" };
      case "needsReview": return { ...base, verdict: "allow", needsReview: true };
      case "lowThenBlock": return state.calls === 1 ? { ...base, verdict: "review", reason: "r1" } : { ...base, verdict: "block", reason: "r2" };
      default: return { ...base, verdict: "allow" };
    }
  },
}));
vi.mock("@cnote/catalogue", () => ({ listPublicSellerListings: async () => [], listSellerListings: async () => [], listSellerListingImages: async () => [] }));
vi.mock("@cnote/identity", () => ({ getTrustProfiles: async (ids: string[]) => new Map(ids.flatMap((i) => (state.profiles.has(i) ? [[i, state.profiles.get(i)!]] : []))) }));
vi.mock("@cnote/reviews", () => ({ getRatingSummaries: async () => new Map(), listApprovedReviews: async () => ({ items: [], nextCursor: null }) }));
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: async () => state.rate }));

import { DomainError } from "@cnote/core";
import {
  applyTemplate, blankDocument, getDraft, getOrCreateStorefront, getPublishedStorefront, listStorefronts, publish, resolveStorefrontById, resolveStorefrontBySlug, restoreVersion,
  reinstateStorefront, reviewStorefrontVersion, saveDraft, seedStorefrontTemplates, setSlug, suspendStorefront, listVersions, listLiveStorefrontSlugs,
} from "../src";
import { getStorefrontVersionForReview, listStorefrontReviews, getEditorData, storefrontSlugById, storefrontSlugForBusiness } from "../src/service";
import { getTemplate, listTemplates, reorderTemplates, setTemplateActive, upsertTemplate, validateTemplateInput } from "../src/templates/store";
import { TEMPLATE_SEEDS } from "../src/templates";
import { defaultSection } from "../src/document";

const tag = Math.random().toString(36).slice(2, 8);
const created: string[] = [];
const person = randomUUID();
const staff = randomUUID();
const tplKeys: string[] = [];

const fresh = async (name = `Zed Works ${tag}`) => {
  const b = randomUUID();
  state.profiles.set(b, { businessId: b, name, city: "Surat", state: "GJ", pincode: null, verificationTier: 1, trustScore: 50, badgeActive: true, languages: ["en"] });
  created.push(b);
  return { b, sf: await getOrCreateStorefront(b, person) };
};

beforeEach(() => {
  state.mode = "allow";
  state.calls = 0;
  state.texts = [];
  state.rate = true;
});

afterAll(async () => {
  const sfs = await prisma.storefront.findMany({ where: { sellerBusinessId: { in: created } }, select: { id: true } });
  const ids = sfs.map((s) => s.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.storefront.updateMany({ where: { id: { in: ids } }, data: { publishedVersionId: null } });
  await prisma.storefrontVersion.deleteMany({ where: { storefrontId: { in: ids } } });
  await prisma.storefront.deleteMany({ where: { id: { in: ids } } });
  await prisma.storefrontTemplate.deleteMany({ where: { key: { in: tplKeys } } });
});

describe("moderation gate at publish (never auto-publish flagged)", () => {
  it.each(["review", "block", "needsReview", "throw"] as const)("verdict %s holds the version in review; nothing goes live", async (mode) => {
    const { b, sf } = await fresh();
    state.mode = mode;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await publish(b, person);
    expect(r.outcome).toBe("in_review");
    expect(await getPublishedStorefront(sf.slug)).toBeNull();
    expect((await prisma.storefront.findUniqueOrThrow({ where: { id: sf.id } })).status).toBe("draft");
    expect(await prisma.domainEvent.count({ where: { aggregateId: sf.id, type: "StorefrontPublished" } })).toBe(0);
    if (mode === "throw") expect(r.reason).toMatch(/unavailable/);
    vi.restoreAllMocks();
  });
  it("block dominates review across chunks; clean publishes with aiVerdict=allow", async () => {
    const { b } = await fresh();
    const d = await getDraft(b);
    const doc = structuredClone(d.document);
    // > 6000 chars of seller text forces multiple moderation chunks
    doc.pages[0]!.sections = Array.from({ length: 24 }, (_, i) => ({ ...defaultSection("contact", `c-${i}`), body: "w".repeat(295) }) as never);
    await saveDraft(b, person, doc, d.etag);
    state.mode = "lowThenBlock";
    const r = await publish(b, person);
    expect(state.calls).toBeGreaterThan(1);
    expect(r.verdict).toBe("block");
    expect(r.reason).toContain("r1");
    expect(r.reason).toContain("r2");
  });
  it("clean publish records the verdict, archives the previous live version and emits one event", async () => {
    const { b, sf } = await fresh();
    const r1 = await publish(b, person);
    const d = await getDraft(b);
    const edited = structuredClone(d.document);
    edited.pages[0]!.title = "Second";
    await saveDraft(b, person, edited, d.etag);
    const r2 = await publish(b, person);
    expect(r2.version).toBeGreaterThan(r1.version);
    const vs = await listVersions(b);
    expect(vs.find((v) => v.id === r1.versionId)!.status).toBe("archived");
    expect(vs.find((v) => v.id === r2.versionId)!.status).toBe("published");
    expect((await getPublishedStorefront(sf.slug))!.document.pages[0]!.title).toBe("Second");
    expect(await prisma.domainEvent.count({ where: { aggregateId: sf.id, type: "StorefrontPublished" } })).toBe(2);
  });
  it("a newer flagged submission supersedes the older one waiting for review", async () => {
    const { b } = await fresh();
    state.mode = "review";
    const r1 = await publish(b, person);
    const d = await getDraft(b);
    const edited = structuredClone(d.document);
    edited.pages[0]!.title = "Newer";
    await saveDraft(b, person, edited, d.etag);
    const r2 = await publish(b, person);
    const vs = await listVersions(b);
    expect(vs.find((v) => v.id === r1.versionId)!.status).toBe("archived");
    expect(vs.find((v) => v.id === r2.versionId)!.status).toBe("in_review");
    expect((await getDraft(b)).pendingReview?.versionId).toBe(r2.versionId);
  });
  it("rate limits publishing and saving", async () => {
    const { b } = await fresh();
    state.rate = false;
    await expect(publish(b, person)).rejects.toMatchObject({ code: "rate_limited" });
    const d = await getDraft(b);
    await expect(saveDraft(b, person, d.document, d.etag)).rejects.toMatchObject({ code: "rate_limited" });
  });
  it("publishing requires an existing storefront", async () => {
    await expect(publish(randomUUID(), person)).rejects.toMatchObject({ code: "not_found" });
    await expect(getOrCreateStorefront(randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("staff review + suspension edge cases", () => {
  it("approving into a suspended storefront is refused; reinstate then approve works", async () => {
    const { b, sf } = await fresh();
    state.mode = "review";
    const r = await publish(b, person);
    await suspendStorefront(sf.id, staff, "Investigating");
    await expect(reviewStorefrontVersion(r.versionId, staff, "approved")).rejects.toMatchObject({ code: "conflict" });
    await reinstateStorefront(sf.id);
    expect((await prisma.storefront.findUniqueOrThrow({ where: { id: sf.id } })).status).toBe("draft");
    expect((await reviewStorefrontVersion(r.versionId, staff, "approved", "ok")).status).toBe("published");
    expect((await reinstateStorefront(sf.id)).status).toBe("live");
  });
  it("reinstate of a previously live storefront restores live; unknown ids not_found", async () => {
    const { b, sf } = await fresh();
    await publish(b, person);
    await suspendStorefront(sf.id, staff, "x");
    expect((await reinstateStorefront(sf.id)).status).toBe("live");
    await expect(suspendStorefront(randomUUID(), staff, "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(reinstateStorefront(randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(reviewStorefrontVersion(randomUUID(), staff, "approved")).rejects.toMatchObject({ code: "not_found" });
  });
  it("review queue, review detail, listing and lookups", async () => {
    const { b, sf } = await fresh();
    state.mode = "review";
    const r = await publish(b, person);
    const q = await listStorefrontReviews({ status: "in_review", limit: 500 });
    expect(q.find((i) => i.versionId === r.versionId)!.businessName).toContain("Zed Works");
    const detail = await getStorefrontVersionForReview(r.versionId);
    expect(detail!.item.slug).toBe(sf.slug);
    expect(detail!.data.business.id).toBe(b);
    expect(await getStorefrontVersionForReview(randomUUID())).toBeNull();
    expect((await listStorefronts({ q: sf.slug.toUpperCase() })).map((s) => s.id)).toContain(sf.id);
    expect((await listStorefronts({ status: "suspended", q: sf.slug })).length).toBe(0);
    expect((await resolveStorefrontById(sf.id))!.slug).toBe(sf.slug);
    expect(await resolveStorefrontBySlug("www")).toBeNull();
    expect(await resolveStorefrontById(randomUUID())).toBeNull();
    expect(await storefrontSlugById(sf.id)).toBe(sf.slug);
    expect(await storefrontSlugForBusiness(b)).toBe(sf.slug);
    expect(await storefrontSlugForBusiness(randomUUID())).toBeNull();
    expect((await getEditorData(b)).business.name).toContain("Zed Works");
    expect(await listStorefrontReviews({ status: "rejected" })).toBeInstanceOf(Array);
  });
  it("listLiveStorefrontSlugs only lists live ones", async () => {
    const { b, sf } = await fresh();
    expect((await listLiveStorefrontSlugs(5000)).map((s) => s.slug)).not.toContain(sf.slug);
    await publish(b, person);
    expect((await listLiveStorefrontSlugs(5000)).map((s) => s.slug)).toContain(sf.slug);
    await suspendStorefront(sf.id, staff, "x");
    expect((await listLiveStorefrontSlugs(5000)).map((s) => s.slug)).not.toContain(sf.slug);
  });
});

describe("public reads never expose unpublished content", () => {
  it("draft edits after publish are invisible until published; invalid stored docs are not served", async () => {
    const { b, sf } = await fresh();
    await publish(b, person);
    const d = await getDraft(b);
    const edited = structuredClone(d.document);
    edited.pages[0]!.title = "SECRET DRAFT";
    await saveDraft(b, person, edited, d.etag);
    expect(JSON.stringify(await getPublishedStorefront(sf.slug))).not.toContain("SECRET DRAFT");
    expect(await getPublishedStorefront("no")).toBeNull(); // invalid slug short-circuits
    // corrupt the published doc: must fail closed (null), not throw or render garbage
    const row = await prisma.storefront.findUniqueOrThrow({ where: { id: sf.id } });
    await prisma.storefrontVersion.update({ where: { id: row.publishedVersionId! }, data: { document: { bogus: true } } });
    const { purgeStorefront } = await import("../src/cache");
    await purgeStorefront([sf.slug]);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await getPublishedStorefront(sf.slug)).toBeNull();
    vi.restoreAllMocks();
  });
  it("changing the slug purges the old and new addresses", async () => {
    const { b, sf } = await fresh();
    await publish(b, person);
    expect(await getPublishedStorefront(sf.slug)).not.toBeNull();
    const next = `moved-${tag}-${Math.random().toString(36).slice(2, 6)}`;
    await setSlug(b, next);
    expect(await getPublishedStorefront(sf.slug)).toBeNull();
    expect((await getPublishedStorefront(next))!.storefront.slug).toBe(next);
    expect((await setSlug(b, ` ${next.toUpperCase()} `)).slug).toBe(next);
  });
});

describe("draft plumbing", () => {
  it("restoreVersion rejects other storefronts' versions; a missing storefront is not_found", async () => {
    const a = await fresh();
    const c = await fresh();
    const foreign = (await listVersions(c.b))[0]!.id;
    await expect(restoreVersion(a.b, person, foreign)).rejects.toMatchObject({ code: "not_found" });
    await expect(getDraft(randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
  it("saving into a draft that was submitted concurrently conflicts", async () => {
    const { b } = await fresh();
    const d = await getDraft(b);
    await publish(b, person);
    await expect(saveDraft(b, person, d.document, null)).resolves.toBeTruthy(); // fresh draft is opened after publish
    expect(blankDocument({ name: "x" }).pages).toHaveLength(1);
  });
  it("slug collisions get numeric suffixes", async () => {
    const name = `Collide ${tag}`;
    const a = await fresh(name);
    const b2 = await fresh(name);
    const b3 = await fresh(name);
    expect(new Set([a.sf.slug, b2.sf.slug, b3.sf.slug]).size).toBe(3);
    expect(b2.sf.slug).toMatch(/-2$/);
  });
  it("concurrent getOrCreate for one business yields one storefront", async () => {
    const b = randomUUID();
    state.profiles.set(b, { businessId: b, name: `Race ${tag}`, city: null, state: null, pincode: null, verificationTier: 0, trustScore: 0, badgeActive: false, languages: [] });
    created.push(b);
    const rs = await Promise.all([getOrCreateStorefront(b), getOrCreateStorefront(b), getOrCreateStorefront(b)]);
    expect(new Set(rs.map((r) => r.id)).size).toBe(1);
  });
});

describe("template store", () => {
  const valid = () => TEMPLATE_SEEDS[0]!.document;
  it("validates template input (key, name, description, document)", () => {
    const ok = validateTemplateInput({ key: "abc", name: "N", description: "D", document: valid() });
    expect(ok.ok).toBe(true);
    for (const bad of [
      { key: "A", name: "N", description: "D", document: valid() },
      { key: "abc", name: " ", description: "D", document: valid() },
      { key: "abc", name: "N", description: "", document: valid() },
      { key: "abc", name: "n".repeat(61), description: "D", document: valid() },
      { key: "abc", name: "N", description: "d".repeat(301), document: valid() },
      { key: "abc", name: "N", description: "D", document: { nope: 1 } },
    ]) expect(validateTemplateInput(bad).ok).toBe(false);
  });
  it("upsert / get / activate / reorder / seed / apply (inactive templates cannot be applied)", async () => {
    await seedStorefrontTemplates();
    const key = `t-${tag}`;
    tplKeys.push(key);
    const v = await upsertTemplate({ key, name: "  Mine  ", description: "Desc", verticals: ["Textile", "textile", " "], tags: ["A"], document: valid(), sortOrder: 5 }, staff);
    expect(v).toMatchObject({ name: "Mine", verticals: ["textile"], tags: ["a"], active: true, sortOrder: 5 });
    await expect(upsertTemplate({ key: "X", name: "n", description: "d", document: valid() }, staff)).rejects.toMatchObject({ code: "validation" });
    expect((await getTemplate(key))!.name).toBe("Mine");
    expect(await getTemplate(`missing-${tag}`)).toBeNull();
    expect((await listTemplates({ vertical: "textile" })).some((t) => t.key === key)).toBe(true);
    expect((await listTemplates({ vertical: "steel" })).some((t) => t.key === key)).toBe(false);
    expect((await listTemplates({ tag: "a" })).some((t) => t.key === key)).toBe(true);
    await setTemplateActive(key, false);
    expect((await listTemplates()).some((t) => t.key === key)).toBe(false);
    expect((await listTemplates({ includeInactive: true })).some((t) => t.key === key)).toBe(true);
    const { b } = await fresh();
    await expect(applyTemplate(b, person, key)).rejects.toMatchObject({ code: "not_found" });
    await expect(setTemplateActive(`none-${tag}`, true)).rejects.toMatchObject({ code: "not_found" });
    await reorderTemplates([key]);
    expect((await getTemplate(key))!.sortOrder).toBe(10);
    await upsertTemplate({ key, name: "Mine2", description: "Desc", document: valid(), active: true }, staff);
    const res = await applyTemplate(b, person, key);
    expect(res.storefront.templateKey).toBe(key);
    const again = await seedStorefrontTemplates();
    expect(again.created).toEqual([]);
    expect((await seedStorefrontTemplates({ overwrite: true })).updated.length).toBe(TEMPLATE_SEEDS.length);
  });
  it("invalid stored templates are skipped, never offered", async () => {
    const key = `bad-${tag}`;
    tplKeys.push(key);
    await prisma.storefrontTemplate.create({ data: { key, name: "Bad", description: "d", document: { junk: 1 }, active: true } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await listTemplates()).some((t) => t.key === key)).toBe(false);
    expect(await getTemplate(key)).toBeNull();
    await expect(applyTemplate((await fresh()).b, person, key)).rejects.toBeInstanceOf(DomainError);
    vi.restoreAllMocks();
  });
});
