import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@cnote/db";
import { approvePromotion, archivePromotion, audienceMatches, createPromotion, getActivePromotions, getPromotion, isSafeHref, listPromotions, previewPromotion, returnPromotionToDraft, submitPromotion, updatePromotion, type PromotionInput } from "../src/index";
import { cleanup, DAY, mkBusiness, mkListing, uid } from "./helpers";
import { cacheTags } from "@cnote/core";

const created: string[] = [];
afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: created } } });
  await prisma.promotionItem.deleteMany({ where: { promotionId: { in: created } } });
  await prisma.promotionContent.deleteMany({ where: { promotionId: { in: created } } });
  await prisma.promotion.deleteMany({ where: { id: { in: created } } });
  await cleanup();
});

const maker = uid();
const checker = uid();
const base = (o: Partial<PromotionInput> = {}): PromotionInput => ({
  kind: "hero_banner", template: "hero_split", internalName: "Diwali", surfaces: ["home_hero"], priority: 5,
  startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + DAY),
  contents: [{ locale: "en", headline: "Diwali gifting", subline: "Curated", ctaLabel: "Shop", ctaHref: "/search?q=gift", imageKey: "/media/template-assets/11111111-1111-4111-8111-111111111111", altText: "Gift boxes" }, { locale: "hi", headline: "दिवाली उपहार" }],
  ...o,
});
const mk = async (o: Partial<PromotionInput> = {}, who = maker) => {
  const p = await createPromotion(base(o), who);
  created.push(p.id);
  return p;
};
// unique surface per test so parallel/previous rows never interfere
let n = 0;
const surf = () => (["home_hero", "home_strip", "home_category_tile", "home_panel", "category_top"] as const)[n++ % 5]!;

describe("validation", () => {
  it("requires English, a safe href, alt text with an image, a valid template and window", async () => {
    await expect(createPromotion(base({ contents: [{ locale: "hi", headline: "x" }] }), maker)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/English/) });
    await expect(createPromotion(base({ contents: [{ locale: "en", headline: "x", ctaLabel: "Go", ctaHref: "https://evil.example/x" }] }), maker)).rejects.toMatchObject({ code: "validation" });
    await expect(createPromotion(base({ contents: [{ locale: "en", headline: "x", ctaLabel: "Go", ctaHref: "//evil.example" }] }), maker)).rejects.toMatchObject({ code: "validation" });
    await expect(createPromotion(base({ contents: [{ locale: "en", headline: "x", imageKey: "/media/template-assets/11111111-1111-4111-8111-111111111111" }] }), maker)).rejects.toMatchObject({ message: expect.stringMatching(/Alt text/) });
    await expect(createPromotion(base({ contents: [{ locale: "en", headline: "x", imageKey: "https://cdn.example/x.png", altText: "a" }] }), maker)).rejects.toMatchObject({ code: "validation" });
    await expect(createPromotion(base({ template: "collection_rail" }), maker)).rejects.toMatchObject({ message: expect.stringMatching(/Template must be/) });
    await expect(createPromotion(base({ endsAt: new Date(Date.now() - 2 * DAY) }), maker)).rejects.toMatchObject({ code: "validation" });
    await expect(createPromotion(base({ endsAt: new Date(Date.now() + 400 * DAY) }), maker)).rejects.toMatchObject({ code: "validation" });
    await expect(createPromotion(base({ contents: [{ locale: "en", headline: "a" }, { locale: "en", headline: "b" }] }), maker)).rejects.toMatchObject({ code: "validation" });
    await expect(createPromotion(base({ kind: "collection", template: "collection_rail", items: [{ listingId: uid(), categoryId: uid(), editorNote: "n" }] }), maker)).rejects.toMatchObject({ code: "validation" });
  });
  it("isSafeHref: relative only unless host allow-listed", () => {
    expect(isSafeHref("/categories/x?y=1#z")).toBe(true);
    expect(isSafeHref("//x.com")).toBe(false);
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("https://partner.example/a")).toBe(false);
    process.env.PROMOTIONS_ALLOWED_HOSTS = "partner.example";
    expect(isSafeHref("https://partner.example/a")).toBe(true);
    expect(isSafeHref("http://partner.example/a")).toBe(false);
    delete process.env.PROMOTIONS_ALLOWED_HOSTS;
  });
  it("audienceMatches", () => {
    const q = { locale: "hi", segment: "all", state: "Karnataka" };
    expect(audienceMatches({ segment: "all" }, q)).toBe(true);
    expect(audienceMatches({ segment: "sellers" }, q)).toBe(false);
    expect(audienceMatches({ segment: "all", languages: ["en"] }, q)).toBe(false);
    expect(audienceMatches({ segment: "all", states: ["karnataka"] }, q)).toBe(true);
    expect(audienceMatches({ segment: "all", states: ["Goa"] }, { ...q, state: undefined })).toBe(false);
    expect(audienceMatches("garbage", q)).toBe(false);
  });
});

describe("workflow and the two-person rule", () => {
  it("draft -> in_review -> approved by a DIFFERENT person; approve emits PromotionPublished", async () => {
    const p = await mk({ surfaces: [surf()] });
    expect(p.status).toBe("draft");
    await expect(approvePromotion(p.id, checker)).rejects.toMatchObject({ code: "conflict" }); // not submitted
    await expect(submitPromotion(p.id, checker)).rejects.toMatchObject({ code: "forbidden" }); // only the author submits
    await submitPromotion(p.id, maker);
    await expect(approvePromotion(p.id, maker)).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/two-person/) });
    expect((await getPromotion(p.id))!.status).toBe("in_review");
    const a = await approvePromotion(p.id, checker);
    expect(a).toMatchObject({ status: "approved", approvedBy: checker, createdBy: maker });
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: p.id } })).map((e) => e.type)).toEqual(["PromotionPublished"]);
    await expect(updatePromotion(p.id, base(), maker)).rejects.toMatchObject({ code: "conflict" }); // live promotions are immutable
  });

  it("editing in review returns to draft; reviewer can return it; a collection needs items", async () => {
    const p = await mk({ surfaces: [surf()] });
    await submitPromotion(p.id, maker);
    await expect(returnPromotionToDraft(p.id, maker)).rejects.toMatchObject({ code: "forbidden" });
    expect((await returnPromotionToDraft(p.id, checker)).status).toBe("draft");
    await submitPromotion(p.id, maker);
    expect((await updatePromotion(p.id, base({ internalName: "Edited" }), maker)).status).toBe("draft");
    const c = await mk({ kind: "collection", template: "collection_rail", surfaces: [surf()] });
    await expect(submitPromotion(c.id, maker)).rejects.toMatchObject({ code: "validation" });
  });

  it("someone else's edit makes them the author, so the original author may then approve", async () => {
    const p = await mk({ surfaces: [surf()] });
    const edited = await updatePromotion(p.id, base(), checker);
    expect(edited.createdBy).toBe(checker);
    await submitPromotion(p.id, checker);
    expect((await approvePromotion(p.id, maker)).status).toBe("approved");
  });
});

describe("public read, caching and invalidation", () => {
  it("serves only approved promotions inside the window, best priority first, localised with English fallback", async () => {
    const s = "category_top" as const;
    const lo = await mk({ surfaces: [s], priority: 1, internalName: "lo" });
    const hi = await mk({ surfaces: [s], priority: 9, internalName: "hi" });
    const future = await mk({ surfaces: [s], priority: 99, startsAt: new Date(Date.now() + DAY), endsAt: new Date(Date.now() + 2 * DAY) });
    const draft = await mk({ surfaces: [s], priority: 50 });
    for (const p of [lo, hi, future]) {
      await submitPromotion(p.id, maker);
      await approvePromotion(p.id, checker);
    }
    const en = await getActivePromotions({ surface: s, locale: "en" });
    const ids = en.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([hi.id, lo.id]));
    expect(ids).not.toContain(future.id);
    expect(ids).not.toContain(draft.id);
    expect(ids.indexOf(hi.id)).toBeLessThan(ids.indexOf(lo.id));
    const hindi = (await getActivePromotions({ surface: s, locale: "hi" })).find((x) => x.id === hi.id)!;
    expect(hindi.headline).toBe("दिवाली उपहार");
    expect(hindi.cta).toBeNull(); // hi block has no CTA: the reader gets exactly what staff wrote for that language
    const ta = (await getActivePromotions({ surface: s, locale: "ta" })).find((x) => x.id === hi.id)!;
    expect(ta.headline).toBe("Diwali gifting");
    expect(ta.image).toEqual({ src: "/media/template-assets/11111111-1111-4111-8111-111111111111", alt: "Gift boxes" });
  });

  it("archive hard-invalidates the cache: a pulled banner disappears immediately", async () => {
    const s = "home_panel" as const;
    const p = await mk({ surfaces: [s], priority: 500 });
    await submitPromotion(p.id, maker);
    await approvePromotion(p.id, checker);
    expect((await getActivePromotions({ surface: s, locale: "en" })).some((x) => x.id === p.id)).toBe(true); // warms the cache
    await expect(archivePromotion(p.id, maker, "  ")).rejects.toMatchObject({ code: "validation" });
    await archivePromotion(p.id, maker, "wrong image");
    expect((await getActivePromotions({ surface: s, locale: "en" })).some((x) => x.id === p.id)).toBe(false);
    expect((await prisma.domainEvent.findMany({ where: { aggregateId: p.id } })).map((e) => e.type)).toContain("PromotionArchived");
    await archivePromotion(p.id, maker, "again"); // idempotent
  });

  it("approving invalidates: a newly approved promotion appears without waiting for the TTL", async () => {
    const s = "home_strip" as const;
    await getActivePromotions({ surface: s, locale: "en" }); // cache the (possibly empty) list
    const p = await mk({ surfaces: [s], priority: 400 });
    await submitPromotion(p.id, maker);
    await approvePromotion(p.id, checker);
    expect((await getActivePromotions({ surface: s, locale: "en" })).some((x) => x.id === p.id)).toBe(true);
  });

  it("audience segments other than 'all' are not served to anonymous readers", async () => {
    const s = "home_category_tile" as const;
    const p = await mk({ surfaces: [s], audience: { segment: "sellers" } });
    await submitPromotion(p.id, maker);
    await approvePromotion(p.id, checker);
    expect((await getActivePromotions({ surface: s, locale: "en" })).some((x) => x.id === p.id)).toBe(false);
    expect((await getActivePromotions({ surface: s, locale: "en", segment: "sellers" })).some((x) => x.id === p.id)).toBe(true);
  });

  it("collections list only items that pass eligibility at render time (published + seller tier >= 1)", async () => {
    const s = "home_hero" as const;
    const good = await mkBusiness(1);
    const bad = await mkBusiness(0);
    const lg = await mkListing(good.id);
    const lb = await mkListing(bad.id);
    const p = await mk({ kind: "collection", template: "collection_rail", surfaces: [s], priority: 700, items: [{ listingId: lb.id, editorNote: "x" }, { listingId: lg.id, editorNote: "great value" }] });
    await submitPromotion(p.id, maker);
    await approvePromotion(p.id, checker);
    const got = (await getActivePromotions({ surface: s, locale: "en" })).find((x) => x.id === p.id)!;
    expect(got.listingIds).toEqual([lg.id]);
    expect((await previewPromotion(p.id, "en"))[0]!.listingIds).toEqual([lg.id]);
    expect((await listPromotions({ status: "approved" })).some((x) => x.id === p.id)).toBe(true);
    expect(cacheTags.plans).toBeTruthy();
  });

  it("PROMOTIONS_ENABLED=false serves nothing", async () => {
    process.env.PROMOTIONS_ENABLED = "false";
    try {
      expect(await getActivePromotions({ surface: "home_hero", locale: "en" })).toEqual([]);
    } finally {
      delete process.env.PROMOTIONS_ENABLED;
    }
  });
});
