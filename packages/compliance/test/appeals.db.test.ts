import { randomUUID } from "node:crypto";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  getVersionForReview: vi.fn(),
  getImageForModeration: vi.fn(),
  moderateListingImage: vi.fn(),
  getModerationItem: vi.fn(),
  moderate: vi.fn(),
  getStorefrontVersionForReview: vi.fn(),
}));
vi.mock("@cnote/catalogue", async (orig) => ({ ...(await orig<object>()), getVersionForReview: m.getVersionForReview, getImageForModeration: m.getImageForModeration, moderateListingImage: m.moderateListingImage }));
vi.mock("@cnote/reviews", async (orig) => ({ ...(await orig<object>()), getModerationItem: m.getModerationItem, moderate: m.moderate }));
vi.mock("@cnote/storefront", async (orig) => ({ ...(await orig<object>()), getStorefrontVersionForReview: m.getStorefrontVersionForReview }));

import { decideAppeal, describeSubject, fileAppeal, getAppealDetail, listAppeals, listMyAppeals } from "../src";

const owner = randomUUID();
const stranger = randomUUID();
const bizA = randomUUID();
const bizB = randomUUID();
const staff = randomUUID();
const actor = { personId: owner, businessId: bizA };
const ids: string[] = [];
const reason = "The photo shows the actual product and is not misleading.";
const subj = () => randomUUID();

const image = (o: { id: string; status?: string; biz?: string }) => ({ id: o.id, status: o.status ?? "rejected", sellerBusinessId: o.biz ?? bizA, listingTitle: "Box", altText: "alt", moderationNote: "blurry" });
const review = (o: { id: string; status?: string; author?: string }) => ({ id: o.id, status: o.status ?? "rejected", authorPersonId: o.author ?? owner, title: "Great", body: "text", moderationNote: "spam" });
const version = (o: { status?: string; biz?: string | null }) => ({ listingTitle: "L", version: { status: o.status ?? "rejected", reviewNote: "bad title", snapshot: { title: "x" } }, seller: o.biz === null ? null : { businessId: o.biz ?? bizA } });
const store = (o: { status?: string; biz?: string }) => ({ item: { businessName: "Acme", version: 3, status: o.status ?? "rejected", sellerBusinessId: o.biz ?? bizA, reviewNote: "n" }, document: { blocks: [] } });

beforeEach(() => Object.values(m).forEach((f) => f.mockReset()));
afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_type = 'ModerationAppeal' AND aggregate_id IN (SELECT id::text FROM moderation_appeals WHERE person_id = ANY(${[owner, stranger]}::uuid[]))`;
  await prisma.moderationAppeal.deleteMany({ where: { personId: { in: [owner, stranger] } } });
});

describe("fileAppeal", () => {
  it("validates input and identity", async () => {
    await expect(fileAppeal(actor, { subjectType: "review", subjectId: subj(), reason: "short" })).rejects.toMatchObject({ code: "validation" });
    await expect(fileAppeal(actor, { subjectType: "bogus" as never, subjectId: subj(), reason })).rejects.toMatchObject({ code: "validation" });
    await expect(fileAppeal({ personId: "x" }, { subjectType: "review", subjectId: subj(), reason })).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("not_found for unknown or malformed subjects", async () => {
    m.getImageForModeration.mockResolvedValue(null);
    await expect(fileAppeal(actor, { subjectType: "listing_image", subjectId: subj(), reason })).rejects.toMatchObject({ code: "not_found" });
    await expect(fileAppeal(actor, { subjectType: "listing_image", subjectId: "nope", reason })).rejects.toMatchObject({ code: "not_found" });
    expect(m.getImageForModeration).toHaveBeenCalledTimes(1);
  });

  it("forbidden for non-owners (business and person owned)", async () => {
    const i = subj();
    m.getImageForModeration.mockResolvedValue(image({ id: i, biz: bizB }));
    await expect(fileAppeal(actor, { subjectType: "listing_image", subjectId: i, reason })).rejects.toMatchObject({ code: "forbidden" });
    await expect(fileAppeal({ personId: owner }, { subjectType: "listing_image", subjectId: i, reason })).rejects.toMatchObject({ code: "forbidden" });
    const r = subj();
    m.getModerationItem.mockResolvedValue(review({ id: r, author: stranger }));
    await expect(fileAppeal(actor, { subjectType: "review", subjectId: r, reason })).rejects.toMatchObject({ code: "forbidden" });
    m.getVersionForReview.mockResolvedValue(version({ biz: null }));
    await expect(fileAppeal(actor, { subjectType: "listing_version", subjectId: subj(), reason })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("only rejected subjects can be appealed", async () => {
    for (const status of ["approved", "pending", "flagged"]) {
      const i = subj();
      m.getImageForModeration.mockResolvedValue(image({ id: i, status }));
      await expect(fileAppeal(actor, { subjectType: "listing_image", subjectId: i, reason })).rejects.toMatchObject({ code: "conflict" });
    }
  });

  it("files an appeal for every subject type and emits AppealFiled", async () => {
    const [img, rev, com, ver, sf] = [subj(), subj(), subj(), subj(), subj()];
    m.getImageForModeration.mockResolvedValue(image({ id: img }));
    m.getModerationItem.mockResolvedValue(review({ id: rev }));
    m.getVersionForReview.mockResolvedValue(version({}));
    m.getStorefrontVersionForReview.mockResolvedValue(store({}));
    const cases = [["listing_image", img], ["review", rev], ["comment", com], ["listing_version", ver], ["storefront_version", sf]] as const;
    for (const [subjectType, subjectId] of cases) {
      const a = await fileAppeal(actor, { subjectType, subjectId, reason });
      ids.push(a.id);
      expect(a).toMatchObject({ status: "open", personId: owner, subjectType, subjectId, needsFollowUp: false });
      const ev = await prisma.domainEvent.findFirst({ where: { type: "AppealFiled", aggregateId: a.id } });
      expect(ev?.payload).toMatchObject({ appealId: a.id, subjectId });
    }
    expect((await listMyAppeals(owner)).length).toBeGreaterThanOrEqual(5);
    expect(await listMyAppeals("bad")).toEqual([]);
  });

  it("one appeal per subject and person: open blocks, decided is final, concurrent race resolves to one", async () => {
    const i = subj();
    m.getImageForModeration.mockResolvedValue(image({ id: i }));
    const first = await fileAppeal(actor, { subjectType: "listing_image", subjectId: i, reason });
    await expect(fileAppeal(actor, { subjectType: "listing_image", subjectId: i, reason })).rejects.toThrow(/already have an open appeal/);
    m.moderateListingImage.mockResolvedValue({});
    await decideAppeal(first.id, "rejected", "Decision stands.", staff);
    await expect(fileAppeal(actor, { subjectType: "listing_image", subjectId: i, reason })).rejects.toThrow(/already been appealed/);

    const j = subj();
    m.getImageForModeration.mockResolvedValue(image({ id: j }));
    const rs = await Promise.allSettled([1, 2, 3].map(() => fileAppeal(actor, { subjectType: "listing_image", subjectId: j, reason })));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of rs) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(DomainError);
  });
});

describe("decideAppeal", () => {
  const open = async (type: "listing_image" | "review" | "comment" | "listing_version" | "storefront_version") => {
    const id = subj();
    m.getImageForModeration.mockResolvedValue(image({ id }));
    m.getModerationItem.mockResolvedValue(review({ id }));
    m.getVersionForReview.mockResolvedValue(version({}));
    m.getStorefrontVersionForReview.mockResolvedValue(store({}));
    const a = await fileAppeal(actor, { subjectType: type, subjectId: id, reason });
    ids.push(a.id);
    return a;
  };

  it("validates note, staff and existence", async () => {
    const a = await open("review");
    await expect(decideAppeal(a.id, "resolved", "no", staff)).rejects.toMatchObject({ code: "validation" });
    await expect(decideAppeal(a.id, "resolved", "Looks fine now", "bad")).rejects.toMatchObject({ code: "forbidden" });
    await expect(decideAppeal(randomUUID(), "resolved", "Looks fine now", staff)).rejects.toMatchObject({ code: "not_found" });
    await expect(decideAppeal("bad", "resolved", "Looks fine now", staff)).rejects.toMatchObject({ code: "not_found" });
  });

  it("upheld image appeal re-approves through catalogue.moderateListingImage and emits AppealDecided", async () => {
    const a = await open("listing_image");
    const d = await decideAppeal(a.id, "resolved", "Photo is fine.", staff);
    expect(m.moderateListingImage).toHaveBeenCalledWith(a.subjectId, "approved", "Reinstated on appeal", staff);
    expect(d).toMatchObject({ status: "resolved", decidedBy: staff, decisionNote: "Photo is fine.", needsFollowUp: false });
    const ev = await prisma.domainEvent.findFirst({ where: { type: "AppealDecided", aggregateId: a.id } });
    expect(ev?.payload).toMatchObject({ status: "resolved", personId: owner });
    await expect(decideAppeal(a.id, "rejected", "Second thoughts", staff)).rejects.toMatchObject({ code: "conflict" });
  });

  it("upheld review and comment appeals call reviews.moderate with the right kind", async () => {
    const r = await open("review");
    await decideAppeal(r.id, "resolved", "Review is genuine.", staff);
    expect(m.moderate).toHaveBeenCalledWith("review", r.subjectId, "approved", "Reinstated on appeal", staff);
    const c = await open("comment");
    await decideAppeal(c.id, "resolved", "Comment is fine.", staff);
    expect(m.moderate).toHaveBeenLastCalledWith("comment", c.subjectId, "approved", "Reinstated on appeal", staff);
  });

  it("an owner-module conflict (already approved) counts as success; other errors abort the decision", async () => {
    const a = await open("listing_image");
    m.moderateListingImage.mockRejectedValueOnce(new DomainError("conflict", "Image is already approved"));
    expect((await decideAppeal(a.id, "resolved", "Already fine.", staff)).status).toBe("resolved");
    const b = await open("listing_image");
    m.moderateListingImage.mockRejectedValueOnce(new Error("boom"));
    await expect(decideAppeal(b.id, "resolved", "Try again.", staff)).rejects.toThrow("boom");
    expect((await prisma.moderationAppeal.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("open");
  });

  it("upheld version appeals are NOT automated: resolved with a follow-up marker", async () => {
    for (const type of ["listing_version", "storefront_version"] as const) {
      const a = await open(type);
      const d = await decideAppeal(a.id, "resolved", "Title was acceptable.", staff);
      expect(d.needsFollowUp).toBe(true);
      expect(d.decisionNote).toContain("[follow-up]");
    }
    expect(m.moderateListingImage).not.toHaveBeenCalled();
    expect(m.moderate).not.toHaveBeenCalled();
  });

  it("a rejected appeal changes nothing in the owning module", async () => {
    const a = await open("listing_image");
    const d = await decideAppeal(a.id, "rejected", "The image is misleading.", staff);
    expect(d.status).toBe("rejected");
    expect(m.moderateListingImage).not.toHaveBeenCalled();
  });

  it("queues and detail", async () => {
    const a = await open("review");
    expect((await listAppeals({ status: "open", limit: 200 })).map((x) => x.id)).toContain(a.id);
    expect((await listAppeals()).length).toBeGreaterThan(0);
    const detail = await getAppealDetail(a.id);
    expect(detail?.appeal.id).toBe(a.id);
    expect(detail?.subject).toMatchObject({ type: "review", rejected: true, content: "text", moderationNote: "spam" });
    expect(await getAppealDetail("bad")).toBeNull();
    expect(await getAppealDetail(randomUUID())).toBeNull();
  });
});

describe("describeSubject", () => {
  it("maps each owning module's view, handling missing items", async () => {
    const i = subj();
    m.getVersionForReview.mockResolvedValue(version({}));
    expect(await describeSubject("listing_version", i)).toMatchObject({ ownerBusinessId: bizA, rejected: true, title: "L" });
    m.getVersionForReview.mockResolvedValue(null);
    expect(await describeSubject("listing_version", i)).toBeNull();
    m.getImageForModeration.mockResolvedValue({ ...image({ id: i }), altText: null });
    expect(await describeSubject("listing_image", i)).toMatchObject({ content: "Image" });
    m.getModerationItem.mockResolvedValue(null);
    expect(await describeSubject("comment", i)).toBeNull();
    m.getModerationItem.mockResolvedValue({ ...review({ id: i }), title: null, authorPersonId: "" });
    expect(await describeSubject("comment", i)).toMatchObject({ title: "Comment", ownerPersonId: null });
    expect(await describeSubject("review", i)).toMatchObject({ title: "Review" });
    m.getStorefrontVersionForReview.mockResolvedValue(null);
    expect(await describeSubject("storefront_version", i)).toBeNull();
    m.getStorefrontVersionForReview.mockResolvedValue(store({ status: "in_review" }));
    expect(await describeSubject("storefront_version", i)).toMatchObject({ rejected: false, title: "Acme storefront v3" });
    m.getImageForModeration.mockResolvedValue(null);
    expect(await describeSubject("listing_image", i)).toBeNull();
  });
});
