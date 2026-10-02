// State machine, publisher, LIVE visibility and read-path tests. DB-backed (isolated cnote_test / cnote_live_test).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM, prisma } from "@cnote/db";
import { liveDb, toVectorLiteral } from "@cnote/live-db";

const vec = (axis: number, tilt = 0) => Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === axis ? 1 : i === axis + 1 ? tilt : 0));
let embedVersion = "lc-v1";
const aiMock = vi.hoisted(() => ({ extract: null as null | (() => unknown) }));
vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => vec(0)), version: embedVersion }),
  moderate: async (i: { text: string }) => ({
    verdict: /blockme/i.test(i.text) ? "block" : /reviewme/i.test(i.text) ? "review" : "allow",
    flags: /blockme/i.test(i.text) ? ["bad"] : [], reason: /blockme/i.test(i.text) ? "policy" : null, decisionId: "d", confidence: 0.9,
    needsReview: /flagme/i.test(i.text), deterministic: "clean",
  }),
  extractListing: async () => aiMock.extract?.(),
}));

process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret";
process.env.LISTING_AUTO_APPROVE_MIN_HUMAN_APPROVED = "0";
process.env.LISTING_AUTO_APPROVE_SAMPLE_RATE = "0";
const cat = await import("../src/index");
const live = await import("../src/live");
const { invalidateTags, cacheTags } = await import("@cnote/core");
const { bustListingCaches } = await import("../src/cache");
const tag = randomUUID().slice(0, 8);
let catId = "";
let catNoAttr = "";
const bizIds: string[] = [];
const staff = randomUUID();

const mkSeller = async (tier: number, trust: number, name = "S") => {
  const b = await prisma.business.create({ data: { name: `${name} ${tag}`, isSeller: true, verificationTier: tier, trustScore: trust, createdAt: new Date(Date.now() - 90 * 86_400_000) } });
  bizIds.push(b.id);
  return b.id;
};
const input = (title: string, extra: Record<string, unknown> = {}) => ({
  categoryId: catId, title: `${title} ${tag}`, description: `${title} description long enough ${tag}`, attributes: { ply: 3 },
  pricePaise: 1000, priceUnit: "piece", moq: 10, moqUnit: "piece", hsn: null, language: "en", imageUrls: [], ...extra,
});
const liveRow = (id: string) => liveDb.liveListing.findUnique({ where: { id } });
const evs = (id: string) => prisma.domainEvent.findMany({ where: { aggregateId: id }, orderBy: { id: "asc" } }).then((r) => r.map((e) => e.type));
const vstatus = (id: string) => prisma.listingVersion.findUniqueOrThrow({ where: { id } }).then((v) => v.status);

beforeAll(async () => {
  const cs = await cat.upsertCategories([
    { slug: `lc-a-${tag}`, name: "LC Cat", attributeSchema: { fields: [{ key: "ply", label: "Ply", type: "number", required: true }, { key: "grade", label: "Grade", type: "select", options: ["A", "B"] }] } },
    { slug: `lc-b-${tag}`, name: "LC Plain" },
  ]);
  catId = cs[0]!.id;
  catNoAttr = cs[1]!.id;
});

afterAll(async () => {
  const ids = (await prisma.listing.findMany({ where: { sellerBusinessId: { in: bizIds } }, select: { id: true } })).map((l) => l.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } }).catch(() => {});
  await liveDb.liveListing.deleteMany({ where: { id: { in: ids } } });
  await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { liveVersionId: null } });
  await prisma.listingVersion.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { id: { in: ids } } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  // tolerate a foreign draft: draftListingFromText/Photos fall back to the first category in the DB, so a parallel file may still reference this one
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } }).catch(() => {});
});

describe("auto-approve policy boundaries (tier x trust x verdict)", () => {
  const table: [number, number, string, string][] = [
    [1, 60, "clean", "approved"],
    [1, 59, "clean", "in_review"],
    [0, 100, "clean", "in_review"],
    [2, 60, "clean", "approved"],
    [3, 100, "clean", "approved"],
    [1, 60, "reviewme", "in_review"],
    [2, 90, "flagme", "in_review"],
    [2, 90, "blockme", "rejected"],
    [0, 0, "blockme", "rejected"],
  ];
  it.each(table)("tier %i trust %i verdict %s → %s", async (tier, trust, verdict, want) => {
    const s = await mkSeller(tier, trust, `p${tier}${trust}`);
    const l = await cat.createListing(s, input(verdict === "clean" ? "Policy widget" : `Policy ${verdict} widget`));
    const v = await cat.submitListingVersion(s, l.id);
    expect(v.status).toBe(want);
    expect(await cat.getPublicListing(l.id)).toBeNull(); // never live straight from submit
    expect(await liveRow(l.id)).toBeNull();
    const w = await cat.getListing(l.id);
    expect(w!.moderationStatus).toBe(want === "approved" ? "approved" : want === "rejected" ? "rejected" : "review");
    expect(w!.status).toBe("draft");
    const e = await evs(l.id);
    expect(e).toContain("ListingVersionSubmitted");
    expect(e.includes("ListingVersionReviewed")).toBe(want !== "in_review");
    if (want === "approved") expect(v.reviewNote).toMatch(/Auto-approved/);
    if (want === "rejected") expect(v).toMatchObject({ reviewNote: "policy", reviewedAt: expect.any(String) });
  });
  it("prohibited category is always rejected, even for a top-trust seller, with no model call cost", async () => {
    const [bad] = await cat.upsertCategories([{ slug: `lc-bad-${tag}`, name: "LC Banned", prohibited: true }]);
    const s = await mkSeller(3, 100, "prohib");
    const l = await cat.createListing(s, input("Nice thing", { categoryId: bad!.id, attributes: {} }));
    const v = await cat.submitListingVersion(s, l.id);
    expect(v.status).toBe("rejected");
    expect(v.aiVerdict).toMatch(/prohibited category/);
    expect((await cat.publishListing(s, l.id)).moderationStatus).toBe("rejected");
    expect(await cat.publishVersion(v.id)).toBe("skipped");
    expect(await liveRow(l.id)).toBeNull();
  });
});

describe("submit validation and versioning", () => {
  it("rejects unknown/short/attribute problems, foreign and missing listings, archived listings", async () => {
    const s = await mkSeller(2, 90, "sv");
    const other = await mkSeller(0, 0, "sv2");
    const short = await cat.createListing(s, input("x", { title: "ab", description: "short" }));
    await expect(cat.submitListingVersion(s, short.id)).rejects.toMatchObject({ code: "validation" });
    const noPly = await cat.createListing(s, input("Noply widget", { attributes: {} }));
    await expect(cat.submitListingVersion(s, noPly.id)).rejects.toThrow(/Ply is required/);
    const badSel = await cat.createListing(s, input("Badsel widget", { attributes: { ply: 1, grade: "Z" } }));
    await expect(cat.submitListingVersion(s, badSel.id)).rejects.toThrow(/Grade must be one of/);
    await expect(cat.submitListingVersion(other, noPly.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(cat.submitListingVersion(s, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(cat.submitListingVersion(s, "nope")).rejects.toMatchObject({ code: "not_found" });
    const good = await cat.createListing(s, input("Arch widget"));
    await cat.archiveListing(s, good.id);
    await expect(cat.submitListingVersion(s, good.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(cat.updateListing(s, good.id, { title: "zzzz" })).rejects.toMatchObject({ code: "conflict" });
    await expect(cat.unpublishListing(s, good.id)).rejects.toMatchObject({ code: "conflict" });
    await cat.archiveListing(s, good.id); // idempotent
  });
  it("select attribute canonicalised on submit; note trimmed & capped; createdBy recorded", async () => {
    const s = await mkSeller(2, 90, "sv3");
    const l = await cat.createListing(s, input("Canon widget", { attributes: { ply: "4", grade: "a" } }));
    const v = await cat.submitListingVersion(s, l.id, { changeNote: `  ${"n".repeat(600)}  `, createdBy: staff });
    expect(v.snapshot.attributes).toEqual({ ply: 4, grade: "A" });
    expect(v.changeNote).toHaveLength(500);
    expect(v.createdBy).toBe(staff);
    expect((await cat.submitListingVersion(s, l.id, { publishAt: null, changeNote: "   " })).changeNote).toBeNull();
  });
  it("publishAt validation: invalid, >1 year, past → immediate", async () => {
    const s = await mkSeller(2, 90, "sv4");
    const l = await cat.createListing(s, input("Sched valid widget"));
    await expect(cat.submitListingVersion(s, l.id, { publishAt: "not a date" })).rejects.toMatchObject({ code: "validation" });
    await expect(cat.submitListingVersion(s, l.id, { publishAt: new Date(Date.now() + 366 * 86400_000) })).rejects.toMatchObject({ code: "validation" });
    const v = await cat.submitListingVersion(s, l.id, { publishAt: new Date(Date.now() - 1000) });
    expect(v.publishAt).toBeNull();
    const v2 = await cat.submitListingVersion(s, l.id, { publishAt: "" });
    expect(v2.publishAt).toBeNull();
    expect(v2.version).toBe(2);
  });
  it("version numbers are monotonic under concurrent submits (P2002 retry) and only the latest stays open", async () => {
    const s = await mkSeller(0, 0, "conc");
    const l = await cat.createListing(s, input("Conc widget"));
    const rs = await Promise.allSettled([1, 2, 3].map(() => cat.submitListingVersion(s, l.id)));
    const versions = (await cat.listListingVersions(s, l.id)).map((v) => v.version).sort();
    expect(rs.filter((r) => r.status === "fulfilled").length).toBe(versions.length);
    expect(new Set(versions).size).toBe(versions.length);
    const open = (await cat.listListingVersions(s, l.id)).filter((v) => v.status === "in_review");
    expect(open).toHaveLength(1);
  });
});

describe("version state machine", () => {
  const seller = async () => mkSeller(0, 0, "sm");
  const mkVersion = async (s: string, title: string) => {
    const l = await cat.createListing(s, input(title));
    return { l, v: await cat.submitListingVersion(s, l.id) };
  };
  it("in_review → approved / rejected; terminal states reject further review", async () => {
    const s = await seller();
    const a = await mkVersion(s, "SM approve");
    expect(a.v.status).toBe("in_review");
    expect((await cat.reviewListingVersion(a.v.id, "approved", " ok ", staff))).toMatchObject({ status: "approved", reviewNote: "ok", reviewedBy: staff });
    await expect(cat.reviewListingVersion(a.v.id, "rejected", "n", staff)).rejects.toMatchObject({ code: "conflict" }); // approved is not reviewable
    await expect(cat.reviewListingVersion(a.v.id, "approved", null, staff)).rejects.toMatchObject({ code: "conflict" });
    expect(await cat.publishVersion(a.v.id)).toBe("published");
    for (const d of ["approved", "rejected"] as const) await expect(cat.reviewListingVersion(a.v.id, d, "x", staff)).rejects.toMatchObject({ code: "conflict" }); // published
    const r = await mkVersion(s, "SM reject");
    await cat.reviewListingVersion(r.v.id, "rejected", "no", staff);
    expect(await vstatus(r.v.id)).toBe("rejected");
    await expect(cat.withdrawVersion(s, r.v.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(cat.reviewListingVersion(randomUUID(), "approved", null, staff)).rejects.toMatchObject({ code: "not_found" });
    await expect(cat.reviewListingVersion("bad", "approved", null, staff)).rejects.toMatchObject({ code: "not_found" });
  });
  it("submitted (transient) can be reviewed; approving a never-live listing marks it approved; rejecting keeps it draft", async () => {
    const s = await seller();
    const { l, v } = await mkVersion(s, "SM submitted");
    await prisma.listingVersion.update({ where: { id: v.id }, data: { status: "submitted" } });
    expect((await cat.reviewListingVersion(v.id, "approved", null, staff)).status).toBe("approved");
    expect(await cat.getListing(l.id)).toMatchObject({ moderationStatus: "approved", status: "draft" });
  });
  it("withdraw: open states only; never-live listing goes back to pending; live version untouched", async () => {
    const s = await seller();
    const { l, v } = await mkVersion(s, "SM withdraw");
    const w = await cat.withdrawVersion(s, v.id);
    expect(w).toMatchObject({ status: "withdrawn", reviewNote: "Withdrawn by seller" });
    expect(await cat.getListing(l.id)).toMatchObject({ moderationStatus: "pending" });
    await expect(cat.withdrawVersion(s, v.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(cat.withdrawVersion(await seller(), v.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(cat.withdrawVersion(s, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(cat.reviewListingVersion(v.id, "approved", null, staff)).rejects.toMatchObject({ code: "conflict" });
    expect(await cat.publishVersion(v.id)).toBe("skipped");
    // approved → withdraw allowed, then live listing keeps its live version
    const t = await mkSeller(2, 90, "smw");
    const l2 = await cat.createListing(t, input("SM withdraw live"));
    const v1 = await cat.submitListingVersion(t, l2.id);
    await cat.publishVersion(v1.id);
    await cat.updateListing(t, l2.id, { description: `edited description long enough ${tag}` });
    const v2 = await cat.submitListingVersion(t, l2.id);
    expect(v2.status).toBe("approved");
    await cat.withdrawVersion(t, v2.id);
    expect(await vstatus(v2.id)).toBe("withdrawn");
    expect((await cat.getPublicListing(l2.id))!.liveVersion).toBe(1);
    expect(await cat.publishVersion(v2.id)).toBe("skipped");
    expect(await vstatus(v1.id)).toBe("published");
  });
  it("publishVersion reports in_progress while another worker holds the version lock, then publishes", async () => {
    const t = await mkSeller(2, 90, "lock");
    const l = await cat.createListing(t, input("SM locked publish"));
    const v = await cat.submitListingVersion(t, l.id);
    expect(v.status).toBe("approved");
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM listing_versions WHERE id = ${v.id}::uuid FOR UPDATE`;
      expect(await cat.publishVersion(v.id)).toBe("in_progress"); // another connection: SKIP LOCKED sees it held
    });
    expect(await cat.publishVersion(v.id)).toBe("published");
  });
  it("publishVersion: only approved versions publish (in_review/rejected/withdrawn/unknown/invalid id skipped)", async () => {
    const s = await seller();
    const { v } = await mkVersion(s, "SM notapproved");
    expect(await cat.publishVersion(v.id)).toBe("skipped");
    expect(await cat.publishVersion(randomUUID())).toBe("skipped");
    expect(await cat.publishVersion("bad")).toBe("skipped");
  });
  it("first publication of a never-live listing emits ListingPublished once; republish emits only VersionPublished", async () => {
    const s = await mkSeller(2, 90, "smp");
    const l = await cat.createListing(s, input("SM events"));
    const v1 = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v1.id);
    await cat.updateListing(s, l.id, { title: `SM events two ${tag}` });
    const v2 = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v2.id);
    const e = await evs(l.id);
    expect(e.filter((x) => x === "ListingPublished")).toHaveLength(1);
    expect(e.filter((x) => x === "ListingVersionPublished")).toHaveLength(2);
    const pub = await prisma.domainEvent.findMany({ where: { aggregateId: l.id, type: "ListingVersionPublished" }, orderBy: { id: "asc" } });
    expect((pub[1]!.payload as { previousVersionId: string }).previousVersionId).toBe(v1.id);
    expect((pub[0]!.payload as { previousVersionId: string | null }).previousVersionId).toBeNull();
  });
  it("review queue: ordering, paging, status filter, seller info", async () => {
    const s = await seller();
    const made: string[] = [];
    for (const t of ["Q one", "Q two", "Q three"]) made.push((await mkVersion(s, t)).v.id);
    const all: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 200; i++) {
      const p = await cat.listVersionReviewQueue({ limit: 2, ...(cursor ? { cursor } : {}) });
      all.push(...p.items.map((x) => x.versionId));
      expect(p.items.every((x) => x.status === "in_review")).toBe(true);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    const mine = all.filter((x) => made.includes(x));
    expect(mine).toEqual(made); // oldest first
    const item = (await cat.listVersionReviewQueue({ limit: 100 })).items.find((x) => x.versionId === made[0]);
    if (item) expect(item).toMatchObject({ sellerBusinessId: s, sellerTier: 0, firstVersion: true, sellerName: `S ${tag}`.replace("S", "sm") });
    const rejected = await cat.listVersionReviewQueue({ status: "rejected", limit: 1000, cursor: "garbage" });
    expect(rejected.items.every((x) => x.status === "rejected")).toBe(true);
    expect((await cat.listVersionReviewQueue({ limit: 0 })).items.length).toBeLessThanOrEqual(1);
  });
  it("getVersionForReview: live diff, seller, missing", async () => {
    const s = await mkSeller(2, 90, "gvr");
    const l = await cat.createListing(s, input("GVR widget"));
    const v1 = await cat.submitListingVersion(s, l.id);
    expect((await cat.getVersionForReview(v1.id))).toMatchObject({ live: null, seller: { businessId: s, tier: 2 } });
    await cat.publishVersion(v1.id);
    await cat.updateListing(s, l.id, { pricePaise: 5000 });
    const v2 = await cat.submitListingVersion(s, l.id);
    const r = await cat.getVersionForReview(v2.id);
    expect(r!.live!.version).toBe(1);
    expect(r!.changes.map((c) => c.field)).toEqual(["pricePaise"]);
    expect(await cat.getVersionForReview(randomUUID())).toBeNull();
    expect(await cat.getVersionForReview("x")).toBeNull();
  });
  it("overview: unsubmittedChanges empty for archived; newest ignores withdrawn/rejected", async () => {
    const s = await mkSeller(0, 0, "ov");
    const l = await cat.createListing(s, input("OV widget"));
    expect((await cat.getVersionOverview(s, l.id)).unsubmittedChanges.length).toBeGreaterThan(0); // never submitted
    const v = await cat.submitListingVersion(s, l.id);
    const o = await cat.getVersionOverview(s, l.id);
    expect(o).toMatchObject({ live: null, pending: { id: v.id }, unsubmittedChanges: [] });
    await cat.withdrawVersion(s, v.id);
    expect((await cat.getVersionOverview(s, l.id)).pending).toBeNull();
    await cat.archiveListing(s, l.id);
    expect((await cat.getVersionOverview(s, l.id)).unsubmittedChanges).toEqual([]);
  });
});

describe("publisher: idempotency, ordering, concurrency, schedule", () => {
  it("concurrent publishers publish exactly once", async () => {
    const s = await mkSeller(2, 90, "cp");
    const l = await cat.createListing(s, input("CP widget"));
    const v = await cat.submitListingVersion(s, l.id);
    const outs = await Promise.all([1, 2, 3, 4, 5].map(() => cat.publishVersion(v.id)));
    expect(outs.filter((o) => o === "published")).toHaveLength(1);
    expect(outs.filter((o) => o !== "published").every((o) => o === "skipped" || o === "in_progress")).toBe(true); // losers: still locked, or already published
    const e = await evs(l.id);
    expect(e.filter((x) => x === "ListingVersionPublished")).toHaveLength(1);
    expect(e.filter((x) => x === "ListingPublished")).toHaveLength(1);
    expect(await liveDb.liveListing.count({ where: { id: l.id } })).toBe(1);
    expect(await cat.publishVersion(v.id)).toBe("skipped");
  });
  it("an older approved version never overwrites a newer live one", async () => {
    const s = await mkSeller(2, 90, "ord");
    const l = await cat.createListing(s, input("ORD widget"));
    const v1 = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v1.id);
    await cat.updateListing(s, l.id, { title: `ORD widget NEW ${tag}` });
    const v2 = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v2.id);
    // resurrect v1 as approved (e.g. replayed event / manual DB fix)
    await prisma.listingVersion.update({ where: { id: v1.id }, data: { status: "approved" } });
    expect(await cat.publishVersion(v1.id)).toBe("skipped");
    expect(await vstatus(v1.id)).toBe("superseded");
    expect((await liveRow(l.id))!.title).toBe(`ORD widget NEW ${tag}`);
    expect((await cat.getPublicListing(l.id))!.liveVersion).toBe(2);
    expect((await prisma.listing.findUnique({ where: { id: l.id } }))!.liveVersionId).toBe(v2.id);
  });
  it("scheduled publishAt is respected with an injected clock (not_due → published at/after)", async () => {
    const s = await mkSeller(2, 90, "sch");
    const l = await cat.createListing(s, input("SCH widget"));
    const at = new Date(Date.now() + 10 * 86400_000);
    const v = await cat.submitListingVersion(s, l.id, { publishAt: at });
    expect(v.status).toBe("approved");
    expect(await cat.publishVersion(v.id, new Date(at.getTime() - 1))).toBe("not_due");
    expect(await cat.getPublicListing(l.id)).toBeNull();
    expect(await liveRow(l.id)).toBeNull();
    expect(await cat.publishVersion(v.id, at)).toBe("published");
    expect((await prisma.listingVersion.findUnique({ where: { id: v.id } }))!.publishedAt!.getTime()).toBe(at.getTime());
    expect((await cat.getPublicListing(l.id))!.liveVersion).toBe(1);
  });
  it("publishDueVersions sweep picks due, leaves future (scoped to this test's listings)", async () => {
    const s = await mkSeller(2, 90, "sweep");
    const due = await cat.createListing(s, input("SWEEP due"));
    const fut = await cat.createListing(s, input("SWEEP future"));
    const vd = await cat.submitListingVersion(s, due.id);
    const vf = await cat.submitListingVersion(s, fut.id, { publishAt: new Date(Date.now() + 5 * 86400_000) });
    const orig = prisma.listingVersion.findMany.bind(prisma.listingVersion);
    const spy = vi.spyOn(prisma.listingVersion, "findMany").mockImplementation(((a: { where?: object }) => orig({ ...a, where: { AND: [a.where ?? {}, { listingId: { in: [due.id, fut.id] } }] } } as never)) as never);
    try {
      expect(await cat.publishDueVersions()).toBe(1);
      expect(await cat.publishDueVersions()).toBe(0); // idempotent
      expect(await cat.publishDueVersions(new Date(Date.now() + 6 * 86400_000))).toBe(1);
    } finally { spy.mockRestore(); }
    expect(await vstatus(vd.id)).toBe("published");
    expect(await vstatus(vf.id)).toBe("published");
  });
  it("publishDueVersions survives a failing version (logged, retried later)", async () => {
    const s = await mkSeller(2, 90, "fail");
    const l = await cat.createListing(s, input("FAIL widget"));
    const v = await cat.submitListingVersion(s, l.id);
    const orig = prisma.listingVersion.findMany.bind(prisma.listingVersion);
    const spy = vi.spyOn(prisma.listingVersion, "findMany").mockImplementation(((a: { where?: object }) => orig({ ...a, where: { AND: [a.where ?? {}, { listingId: l.id }] } } as never)) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await prisma.category.update({ where: { id: catId }, data: { sortOrder: 0 } }); // no-op, keeps category
    const snapRow = await prisma.listingVersion.findUniqueOrThrow({ where: { id: v.id } });
    await prisma.listingVersion.update({ where: { id: v.id }, data: { snapshot: { ...(snapRow.snapshot as object), categoryId: randomUUID() } } });
    try {
      expect(await cat.publishDueVersions()).toBe(0);
      expect(err).toHaveBeenCalled();
    } finally { spy.mockRestore(); err.mockRestore(); }
    expect(await vstatus(v.id)).toBe("approved");
    expect(await liveRow(l.id)).toBeNull();
  });
  it("archived listing: approved version is withdrawn, never goes live", async () => {
    const s = await mkSeller(2, 90, "archpub");
    const l = await cat.createListing(s, input("ARCHPUB widget"));
    const v = await cat.submitListingVersion(s, l.id);
    await prisma.listing.update({ where: { id: l.id }, data: { status: "archived" } });
    expect(await cat.publishVersion(v.id)).toBe("skipped");
    expect(await vstatus(v.id)).toBe("withdrawn");
    expect(await liveRow(l.id)).toBeNull();
  });
  it("event handler: approved publishes, rejected does not", async () => {
    const s = await mkSeller(2, 90, "hnd");
    const l = await cat.createListing(s, input("HND widget"));
    const v = await cat.submitListingVersion(s, l.id);
    const ev = (status: string) => ({ id: 1, type: "ListingVersionReviewed", version: 1, aggregateType: "listing", aggregateId: l.id, occurredAt: new Date().toISOString(), payload: { listingId: l.id, versionId: v.id, version: 1, sellerBusinessId: s, status, reviewedBy: null } }) as never;
    await cat.worker.handlers.ListingVersionReviewed!(ev("rejected"));
    expect(await liveRow(l.id)).toBeNull();
    await cat.worker.handlers.ListingVersionReviewed!(ev("approved"));
    await cat.worker.handlers.ListingVersionReviewed!(ev("approved")); // at-least-once redelivery
    expect(await liveRow(l.id)).not.toBeNull();
    expect((await evs(l.id)).filter((x) => x === "ListingVersionPublished")).toHaveLength(1);
  });
  it("writeLive is monotonic and idempotent; checkpoint recorded", async () => {
    const s = await mkSeller(2, 90, "wl");
    const l = await cat.createListing(s, input("WL widget"));
    const v = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v.id);
    const cp = await liveDb.projectionCheckpoint.findFirst({ where: { consumer: "publisher", key: v.id } });
    expect(cp).not.toBeNull();
    const row = await liveRow(l.id);
    const p = { listingId: l.id, versionId: v.id, version: 1, sellerBusinessId: s, snap: { ...v.snapshot, title: "same version rewrite" }, category: { id: catId, slug: `lc-a-${tag}`, name: "LC Cat" }, images: [], seller: { name: "s", city: null, state: null, tier: 0, trustScore: 0, badgeActive: false }, aiGenerated: false, embedding: vec(0), embeddingVersion: "x", publishedAt: new Date() };
    await live.writeLive(p); // equal version → allowed (idempotent retry)
    expect((await liveRow(l.id))!.title).toBe("same version rewrite");
    await live.writeLive({ ...p, version: 3, snap: { ...p.snap, title: "v3" } });
    await live.writeLive({ ...p, version: 2, snap: { ...p.snap, title: "v2 late" } });
    expect((await liveRow(l.id))!.title).toBe("v3");
    expect(row).not.toBeNull();
  });
});

describe("LIVE is the only public source: unapproved/unpublished content never leaks", () => {
  it("public reads return nothing for draft/in_review/approved-unpublished/rejected/withdrawn; only live version content is served", async () => {
    const s = await mkSeller(0, 0, "vis");
    const l = await cat.createListing(s, input("VIS widget"));
    const check = async () => {
      expect(await cat.getPublicListing(l.id)).toBeNull();
      expect(await cat.getPublicListingsByIds([l.id])).toEqual([]);
      expect((await cat.listPublicSellerListings(s)).map((x) => x.id)).not.toContain(l.id);
      expect((await cat.listFeaturedListings({ sort: "new", limit: 50 })).map((x) => x.id)).not.toContain(l.id);
      expect((await cat.retrieveListings({ text: `VIS widget ${tag}`, embedding: vec(0), limit: 200 })).map((x) => x.listingId)).not.toContain(l.id);
      expect((await cat.findSellerCandidates({ embedding: vec(0), categoryId: catId, limit: 200 })).map((x) => x.listingId)).not.toContain(l.id);
      expect(await cat.suggestListingTitles(`vis widget ${tag}`)).toEqual([]);
    };
    await check(); // draft
    const v1 = await cat.submitListingVersion(s, l.id);
    await check(); // in_review
    await cat.reviewListingVersion(v1.id, "approved", null, staff);
    await check(); // approved, not yet published
    await cat.withdrawVersion(s, v1.id);
    await check(); // withdrawn
    const v2 = await cat.submitListingVersion(s, l.id);
    await cat.reviewListingVersion(v2.id, "rejected", "nope", staff);
    await check(); // rejected
    await cat.updateListing(s, l.id, { title: `VIS widget ok ${tag}` });
    const v3 = await cat.submitListingVersion(s, l.id);
    await cat.reviewListingVersion(v3.id, "approved", null, staff);
    await cat.publishVersion(v3.id);
    expect(await cat.getPublicListing(l.id)).toMatchObject({ liveVersion: 3, status: "published", moderationStatus: "approved" });
    // pending edits (in_review v4) and working-copy edits never bleed into public
    await cat.updateListing(s, l.id, { title: `VIS SECRET ${tag}`, description: `SECRET description text ${tag}` });
    await cat.submitListingVersion(s, l.id);
    const pub = await cat.getPublicListing(l.id);
    expect(pub!.title).toBe(`VIS widget ok ${tag}`);
    expect(JSON.stringify(pub)).not.toMatch(/SECRET/);
    expect(JSON.stringify(await liveRow(l.id), (_k, v) => (typeof v === "bigint" ? Number(v) : v))).not.toMatch(/SECRET/);
    expect(await cat.getListing(l.id)).toMatchObject({ title: `VIS SECRET ${tag}` }); // working copy is separate
  });
  it("unpublish and archive remove from LIVE immediately (cached read too), keep history; archive withdraws pending", async () => {
    const s = await mkSeller(2, 90, "unp");
    const l = await cat.createListing(s, input("UNP widget"));
    const v = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v.id);
    expect(await cat.getPublicListing(l.id)).not.toBeNull(); // populates cache
    expect((await cat.listPublicSellerListings(s)).map((x) => x.id)).toContain(l.id);
    await cat.unpublishListing(s, l.id);
    expect(await cat.getPublicListing(l.id)).toBeNull();
    expect((await cat.listPublicSellerListings(s)).map((x) => x.id)).not.toContain(l.id);
    expect(await liveRow(l.id)).toBeNull();
    expect(await vstatus(v.id)).toBe("superseded");
    expect(await cat.getListing(l.id)).toMatchObject({ status: "draft", moderationStatus: "pending" });
    expect((await prisma.listing.findUnique({ where: { id: l.id } }))!.liveVersionId).toBeNull();
    await cat.unpublishListing(s, l.id); // idempotent
    expect((await evs(l.id)).filter((x) => x === "ListingUnpublished")).toHaveLength(1); // only when it was live
    // resubmit → republish
    await cat.updateListing(s, l.id, { description: `back again description long ${tag}` });
    const v2 = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v2.id);
    expect((await cat.getPublicListing(l.id))!.liveVersion).toBe(2);
    const pend = await (async () => { await cat.updateListing(s, l.id, { title: `UNP pending edit ${tag}` }); return cat.submitListingVersion(s, l.id); })();
    await cat.archiveListing(s, l.id);
    expect(await cat.getPublicListing(l.id)).toBeNull();
    expect(await liveRow(l.id)).toBeNull();
    expect(await vstatus(pend.id)).toBe("withdrawn");
    expect(await evs(l.id)).toContain("ListingArchived");
    expect(await cat.publishVersion(pend.id)).toBe("skipped");
  });
  it("cache invalidation on publish: cached public view flips to the new version; seller list and featured refresh", async () => {
    const s = await mkSeller(2, 90, "cache");
    const l = await cat.createListing(s, input("CACHE widget"));
    const v1 = await cat.submitListingVersion(s, l.id);
    expect(await cat.getPublicListing(l.id)).toBeNull(); // negative results are not stuck
    await cat.publishVersion(v1.id);
    expect((await cat.getPublicListing(l.id))!.title).toBe(`CACHE widget ${tag}`);
    expect((await cat.listPublicSellerListings(s))[0]!.title).toBe(`CACHE widget ${tag}`);
    await new Promise((r) => setTimeout(r, 25)); // invalidation timestamps are ms-granular
    await cat.updateListing(s, l.id, { title: `CACHE widget 2 ${tag}` });
    const v2 = await cat.submitListingVersion(s, l.id);
    await cat.publishVersion(v2.id);
    expect((await cat.getPublicListing(l.id))!.title).toBe(`CACHE widget 2 ${tag}`);
    expect((await cat.listPublicSellerListings(s))[0]!.title).toBe(`CACHE widget 2 ${tag}`);
    // out-of-band LIVE change is invisible until tags are busted, then visible
    await new Promise((r) => setTimeout(r, 25));
    expect((await cat.getPublicListing(l.id))!.title).toBe(`CACHE widget 2 ${tag}`); // warm
    await liveDb.liveListing.update({ where: { id: l.id }, data: { title: "OOB" } });
    expect((await cat.getPublicListing(l.id))!.title).toBe(`CACHE widget 2 ${tag}`);
    await bustListingCaches(l.id, s);
    expect((await cat.getPublicListing(l.id))!.title).toBe("OOB");
    await bustListingCaches(l.id); // seller-less form
  });
  it("public ids: dedupe, order preserved, invalid/unknown dropped", async () => {
    const s = await mkSeller(2, 90, "ids");
    const a = await cat.createListing(s, input("IDS a"));
    const b = await cat.createListing(s, input("IDS b"));
    for (const x of [a, b]) await cat.publishVersion((await cat.submitListingVersion(s, x.id)).id);
    const r = await cat.getPublicListingsByIds([b.id, "bad", randomUUID(), a.id, b.id]);
    expect(r.map((x) => x.id)).toEqual([b.id, a.id, b.id]); // input order preserved; repeated ids repeat (same contract as getListingsByIds)
    expect(await cat.getPublicListingsByIds([])).toEqual([]);
    expect(await cat.getPublicListingsByIds(["bad"])).toEqual([]);
    expect(await cat.getPublicListing("bad")).toBeNull();
  });
});

describe("re-projection, reconcile, backfill, worker wiring", () => {
  it("reprojectSeller/reprojectImages: idempotent, bad ids, not-live", async () => {
    const s = await mkSeller(2, 90, "rp");
    const l = await cat.createListing(s, input("RP widget"));
    expect(await cat.reprojectImages(l.id)).toBe(false); // never live
    expect(await cat.reprojectImages("bad")).toBe(false);
    expect(await cat.reprojectSeller("bad")).toBe(0);
    await cat.publishVersion((await cat.submitListingVersion(s, l.id)).id);
    expect(await cat.reprojectSeller(s)).toBe(0); // snapshot already current
    await prisma.business.update({ where: { id: s }, data: { name: `Renamed ${tag}`, trustScore: 75 } });
    expect(await cat.reprojectSeller(s)).toBe(1);
    expect(await cat.reprojectSeller(s)).toBe(0);
    expect((await cat.getPublicListing(l.id))!.seller).toMatchObject({ name: `Renamed ${tag}`, trustScore: 75 });
    expect(await cat.reprojectImages(l.id)).toBe(false); // no change
    await liveDb.$executeRaw`UPDATE live_listings SET images = '[{"src":"x"}]'::jsonb WHERE id = ${l.id}::uuid`;
    expect(await cat.reprojectImages(l.id)).toBe(true);
    const ev = (type: string, payload: object) => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: l.id, occurredAt: new Date().toISOString(), payload }) as never;
    await prisma.business.update({ where: { id: s }, data: { trustScore: 66 } });
    await cat.worker.handlers.TrustScoreChanged!(ev("TrustScoreChanged", { businessId: s }));
    expect((await liveRow(l.id))!.sellerTrustScore).toBe(66);
    await prisma.business.update({ where: { id: s }, data: { verificationTier: 3 } });
    await cat.worker.handlers.BusinessVerified!(ev("BusinessVerified", { businessId: s }));
    expect((await liveRow(l.id))!.sellerTier).toBe(3);
    await liveDb.$executeRaw`UPDATE live_listings SET images = '[{"src":"x"}]'::jsonb WHERE id = ${l.id}::uuid`;
    await cat.worker.handlers.ListingImageProcessed!(ev("ListingImageProcessed", { listingId: l.id }));
    expect((await liveRow(l.id))!.images).toEqual([]);
    await liveDb.$executeRaw`UPDATE live_listings SET images = '[{"src":"x"}]'::jsonb WHERE id = ${l.id}::uuid`;
    await cat.worker.handlers.ListingImageModerated!(ev("ListingImageModerated", { listingId: l.id }));
    expect((await liveRow(l.id))!.images).toEqual([]);
  });
  it("reconcileLive removes orphans/unpublished rows, restores missing live rows (scoped)", async () => {
    const s = await mkSeller(2, 90, "rec");
    const a = await cat.createListing(s, input("REC a")); // will lose its LIVE row
    const b = await cat.createListing(s, input("REC b")); // authoring says draft but LIVE has a row → must be removed
    for (const x of [a, b]) await cat.publishVersion((await cat.submitListingVersion(s, x.id)).id);
    await liveDb.liveListing.delete({ where: { id: a.id } });
    await prisma.listing.update({ where: { id: b.id }, data: { status: "draft", liveVersionId: null } });
    const mine = [a.id, b.id];
    const orig = liveDb.liveListing.findMany.bind(liveDb.liveListing);
    const spy = vi.spyOn(liveDb.liveListing, "findMany").mockImplementation(((args: { where?: object; take?: number }) => orig({ ...args, where: { AND: [args?.where ?? {}, { id: { in: mine } }] } } as never)) as never);
    const origP = prisma.listing.findMany.bind(prisma.listing);
    const spyP = vi.spyOn(prisma.listing, "findMany").mockImplementation(((args: { where?: { status?: string } }) => origP((args?.where?.status === "published" ? { ...args, where: { ...args.where, id: { in: mine } } } : args) as never) as never) as never);
    try {
      const r1 = await cat.reconcileLive();
      expect(r1.removed).toBe(1);
      expect(r1.restored).toBe(1); // a: authoring claims live but LIVE row was missing
      expect(await liveRow(b.id)).toBeNull();
      expect(await liveRow(a.id)).not.toBeNull();
      const r3 = await cat.reconcileLive();
      expect(r3.removed).toBe(0);
      expect(r3.restored).toBe(0);
    } finally { spy.mockRestore(); spyP.mockRestore(); }
  });
  it("backfillLiveListings: projects published+approved legacy rows once; skips prohibited category", async () => {
    const s = await mkSeller(0, 0, "bf");
    const mk = (title: string, categoryId: string) => prisma.listing.create({ data: { sellerBusinessId: s, categoryId, title: `${title} ${tag}`, description: `${title} legacy description ${tag}`, status: "published", moderationStatus: "approved", attributes: { ply: 2 }, pricePaise: BigInt(500) } });
    const ok = await mk("BF ok", catId);
    const [bad] = await cat.upsertCategories([{ slug: `lc-bf-bad-${tag}`, name: "LC BF bad", prohibited: true }]);
    const no = await mk("BF prohibited", bad!.id);
    const r = await cat.backfillLiveListings({ listingIds: [ok.id, no.id, "bad"] });
    expect(r).toEqual({ projected: 1, skipped: 1 });
    expect((await cat.getPublicListing(ok.id))).toMatchObject({ liveVersion: 1, pricePaise: 500 });
    expect(await liveRow(no.id)).toBeNull();
    expect(await cat.backfillLiveListings({ listingIds: [ok.id] })).toEqual({ projected: 0, skipped: 0 }); // already live
  });
  it("worker registers publish/reconcile/reembed/purge jobs and the image queue", () => {
    expect(cat.worker.jobs!.map((j) => j.name)).toEqual(expect.arrayContaining(["catalogue.publish-due", "catalogue.live-reconcile", "catalogue.reembed-stale", "catalogue.purge-deleted-images"]));
    expect(cat.worker.jobs!.find((j) => j.name === "catalogue.publish-due")!.everyMs).toBe(30_000);
    expect(cat.worker.queues!.map((q) => q.topic)).toContain("media.process_image");
  });
});

describe("retrieval edge cases", () => {
  let s1 = "";
  let s2 = "";
  let ids: string[] = [];
  beforeAll(async () => {
    s1 = await mkSeller(2, 90, "ret1");
    s2 = await mkSeller(2, 90, "ret2");
    const mk = async (s: string, title: string, axis: number, tilt: number, categoryId = catId) => {
      const l = await cat.createListing(s, input(title, { categoryId, attributes: categoryId === catId ? { ply: 1 } : {} }));
      await cat.publishVersion((await cat.submitListingVersion(s, l.id)).id);
      await liveDb.$executeRaw`UPDATE live_listings SET embedding = ${toVectorLiteral(vec(axis, tilt))}::vector WHERE id = ${l.id}::uuid`;
      ids.push(l.id);
      return l.id;
    };
    await mk(s1, "Zebra alpha", 5, 0.1);
    await mk(s1, "Zebra beta", 5, 0.5);
    await mk(s1, "Zebra gamma", 5, 0.9);
    await mk(s2, "Zebra delta", 5, 0.3);
    await mk(s2, "Zebra plain", 5, 0.2, catNoAttr);
  });
  it("findSellerCandidates: one per seller, best first, category filter, limit clamps, invalid excludes ignored", async () => {
    const r = await cat.findSellerCandidates({ embedding: vec(5), categoryId: catId, limit: 50 });
    const mine = r.filter((x) => [s1, s2].includes(x.sellerBusinessId));
    expect(mine.map((x) => x.sellerBusinessId).sort()).toEqual([s1, s2].sort());
    expect(new Set(r.map((x) => x.sellerBusinessId)).size).toBe(r.length);
    const best1 = mine.find((x) => x.sellerBusinessId === s1)!;
    expect((await prisma.listing.findUniqueOrThrow({ where: { id: best1.listingId } })).title).toBe(`Zebra alpha ${tag}`);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.similarity).toBeGreaterThanOrEqual(r[i]!.similarity);
    expect(r.every((x) => x.similarity <= 1 + 1e-9)).toBe(true);
    // s2's best in catNoAttr is closer (0.2) than in catId (0.3)
    const other = await cat.findSellerCandidates({ embedding: vec(5), categoryId: catNoAttr, limit: 50 });
    expect(other.filter((x) => x.sellerBusinessId === s2)).toHaveLength(1);
    expect(other.find((x) => x.sellerBusinessId === s1)).toBeUndefined();
    expect((await cat.findSellerCandidates({ embedding: vec(5), categoryId: catId, limit: 0 })).length).toBe(1); // clamped to ≥1
    expect((await cat.findSellerCandidates({ embedding: vec(5), categoryId: "not-a-uuid", limit: 500, excludeSellerIds: ["junk", s1] })).map((x) => x.sellerBusinessId)).not.toContain(s1);
    const nullCat = await cat.findSellerCandidates({ embedding: vec(5), categoryId: null, limit: 200 });
    expect(nullCat.map((x) => x.sellerBusinessId)).toEqual(expect.arrayContaining([s1, s2]));
  });
  it("retrieveListings: lexical only, vector only, both, none; empty/short/hostile text", async () => {
    const lex = await cat.retrieveListings({ text: `zebra alpha ${tag}`, categoryId: catId, limit: 50 });
    expect(lex.every((x) => x.similarity === 0)).toBe(true);
    const alpha = lex.find((x) => ids.includes(x.listingId))!;
    expect(alpha.lexicalRank).toBeGreaterThan(0);
    const both = await cat.retrieveListings({ text: `zebra ${tag}`, embedding: vec(5), categoryId: catId, limit: 50 });
    expect(both.find((x) => ids.includes(x.listingId))!.sellerBusinessId).toBeTruthy();
    expect(both.some((x) => x.lexicalRank > 0 && x.similarity > 0)).toBe(true);
    expect(await cat.retrieveListings({ limit: 5 })).toEqual([]);
    expect(await cat.retrieveListings({ text: "   ", limit: 5 })).toEqual([]);
    expect(await cat.retrieveListings({ text: "!!! ??? -", limit: 5 })).toEqual([]);
    expect(await cat.retrieveListings({ text: "a", limit: 5 })).toBeDefined();
    await expect(cat.retrieveListings({ text: `zebra'; DROP TABLE live_listings; -- ${tag}`, limit: 5 })).resolves.toBeDefined();
    await expect(cat.retrieveListings({ text: `"unbalanced (zebra & | !`, limit: 5 })).resolves.toBeDefined();
    expect(await cat.retrieveListings({ text: "zzzzqqqq nonexistent", limit: 5 })).toEqual([]);
    expect((await cat.retrieveListings({ text: `zebra ${tag}`, limit: 2 })).length).toBeLessThanOrEqual(2);
    expect((await cat.retrieveListings({ text: `zebra ${tag}`, limit: 1000 })).length).toBeLessThanOrEqual(200);
  });
  it("suggestListingTitles: word-prefix, escape of LIKE wildcards, limit, empty, cached", async () => {
    expect(await cat.suggestListingTitles("")).toEqual([]);
    expect(await cat.suggestListingTitles("   ")).toEqual([]);
    const r = await cat.suggestListingTitles(`zebra alpha ${tag}`.toLowerCase());
    expect(r).toEqual([`Zebra alpha ${tag}`]);
    expect(await cat.suggestListingTitles(`alpha ${tag}`)).toEqual([`Zebra alpha ${tag}`]); // mid-title word prefix
    expect(await cat.suggestListingTitles("%")).toEqual([]);
    expect(await cat.suggestListingTitles("_ebra alpha")).toEqual([]);
    expect((await cat.suggestListingTitles(`zebra`, 1)).length).toBe(1);
    expect(await cat.suggestListingTitles(`zebra alpha ${tag}`)).toEqual(r);
  });
});

describe("reindex (scoped to this file's LIVE rows)", () => {
  it("reindexEmbeddings (all/missing) and stale re-embed only mismatching versions", async () => {
    const s = await mkSeller(2, 90, "rx");
    const mkl = async (t: string) => { const l = await cat.createListing(s, input(t)); await cat.publishVersion((await cat.submitListingVersion(s, l.id)).id); return l.id; };
    const a = await mkl("RX a");
    const b = await mkl("RX b");
    const c = await mkl("RX c");
    const mine = [a, b, c];
    await liveDb.$executeRaw`UPDATE live_listings SET embedding = NULL, embedding_version = NULL WHERE id = ${a}::uuid`;
    await liveDb.$executeRaw`UPDATE live_listings SET embedding_version = 'old' WHERE id = ${b}::uuid`;
    const orig = liveDb.$queryRawUnsafe.bind(liveDb);
    const spy = vi.spyOn(liveDb, "$queryRawUnsafe").mockImplementation(((sql: string, ...a2: unknown[]) => orig(sql.replace("WHERE id > $1::uuid", `WHERE id IN (${mine.map((m) => `'${m}'`).join(",")}) AND id > $1::uuid`), ...a2)) as never);
    const ver = async (id: string) => (await liveDb.$queryRaw<{ v: string | null; has: boolean }[]>`SELECT embedding_version v, embedding IS NOT NULL has FROM live_listings WHERE id = ${id}::uuid`)[0]!;
    try {
      expect(await cat.reindexEmbeddings({ onlyMissing: true })).toEqual({ reindexed: 1 });
      expect(await ver(a)).toEqual({ v: embedVersion, has: true });
      expect((await ver(b)).v).toBe("old"); // untouched by "missing"
      embedVersion = "lc-v2";
      const r = await cat.reindexStaleEmbeddings();
      expect(r.reindexed).toBe(3); // a/c at lc-v1 and b at old all differ from lc-v2
      expect((await ver(b)).v).toBe("lc-v2");
      expect(await cat.reindexStaleEmbeddings()).toEqual({ reindexed: 0 }); // now current
      expect(await cat.reindexEmbeddings()).toEqual({ reindexed: 3 });
    } finally { spy.mockRestore(); embedVersion = "lc-v1"; }
  });
});

describe("getters, sku, listings CRUD edges", () => {
  it("getListingTitles / getSellerListingHsns", async () => {
    const s = await mkSeller(0, 0, "gt");
    const a = await cat.createListing(s, input("GT a", { hsn: "6109" }));
    await cat.createListing(s, input("GT b", { hsn: "6109" }));
    const c = await cat.createListing(s, input("GT c", { hsn: "5208" }));
    const d = await cat.createListing(s, input("GT d", { hsn: "9999" }));
    await cat.archiveListing(s, d.id);
    await cat.createListing(s, input("GT e"));
    const m = await cat.getListingTitles([a.id, a.id, "bad", randomUUID()]);
    expect([...m.keys()]).toEqual([a.id]);
    expect((await cat.getListingTitles([])).size).toBe(0);
    expect((await cat.getListingTitles(["x"])).size).toBe(0);
    expect(await cat.getSellerListingHsns(s)).toEqual(["6109", "5208"]);
    expect(c.id).toBeTruthy();
  });
  it("SKU: create, lookup (case-sensitive), unique per seller, patchable, conflict as DomainError", async () => {
    const s = await mkSeller(0, 0, "sku");
    const t = await mkSeller(0, 0, "sku2");
    const a = await cat.createListing(s, input("SKU a", { sku: "AB-1" }));
    expect(a.sku).toBe("AB-1");
    await expect(cat.createListing(s, input("SKU dup", { sku: "AB-1" }))).rejects.toMatchObject({ code: "conflict" });
    await expect(cat.createListing(s, input("SKU bad", { sku: "a b" }))).rejects.toMatchObject({ code: "validation" });
    expect((await cat.createListing(t, input("SKU other", { sku: "AB-1" }))).sku).toBe("AB-1"); // per seller
    expect((await cat.findSellerListingBySku(s, "AB-1"))!.id).toBe(a.id);
    expect(await cat.findSellerListingBySku(s, "ab-1")).toBeNull();
    expect(await cat.findSellerListingBySku(t, "nope")).toBeNull();
    const b = await cat.createListing(s, input("SKU b"));
    await expect(cat.updateListing(s, b.id, { sku: "AB-1" })).rejects.toMatchObject({ code: "conflict" });
    expect((await cat.updateListing(s, b.id, { sku: "AB-2" })).sku).toBe("AB-2");
  });
  it("create/update validation + ownership; price bigint mapping; moderation reset only for unpublished draft content edits", async () => {
    const s = await mkSeller(0, 0, "crud");
    await expect(cat.createListing(s, input("x", { categoryId: randomUUID() }))).rejects.toMatchObject({ code: "validation" });
    await expect(cat.createListing(s, input("x", { moq: 0 }))).rejects.toMatchObject({ code: "validation" });
    const l = await cat.createListing(s, input("CRUD widget", { attributes: { ply: "7" }, pricePaise: 12345 }));
    expect(l).toMatchObject({ attributes: { ply: 7 }, pricePaise: 12345, status: "draft", moderationStatus: "pending" });
    await expect(cat.updateListing(s, l.id, { status: "published" } as never)).rejects.toMatchObject({ code: "validation" });
    await expect(cat.updateListing(await mkSeller(0, 0, "crud2"), l.id, { title: "hijack" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(cat.updateListing(s, "bad", { title: "abc" })).rejects.toMatchObject({ code: "not_found" });
    const v = await cat.submitListingVersion(s, l.id);
    expect(await cat.getListing(l.id)).toMatchObject({ moderationStatus: "review" });
    await cat.updateListing(s, l.id, { priceUnit: "kg" }); // non-content edit
    expect((await cat.getListing(l.id))!.moderationStatus).toBe("review");
    await cat.updateListing(s, l.id, { title: `CRUD widget edited ${tag}` }); // content edit resets
    expect((await cat.getListing(l.id))!.moderationStatus).toBe("pending");
    expect((await cat.updateListing(s, l.id, { pricePaise: null })).pricePaise).toBeNull();
    expect((await cat.updateListing(s, l.id, { categoryId: catNoAttr })).category.id).toBe(catNoAttr);
    expect(v.version).toBe(1);
    expect((await cat.listSellerListings(s)).map((x) => x.id)).toEqual([l.id]);
    expect(await cat.getListing("bad")).toBeNull();
    expect(await cat.getListingsByIds([])).toEqual([]);
    expect(await cat.getListingsByIds(["bad"])).toEqual([]);
  });
  it("draftListingFromText: validation, category fallback, junk extraction sanitised, prohibited never chosen, unknown language → en", async () => {
    const s = await mkSeller(0, 0, "draft");
    await expect(cat.draftListingFromText(s, "ab", "en")).rejects.toMatchObject({ code: "validation" });
    await expect(cat.draftListingFromText(s, "x".repeat(5001), "en")).rejects.toMatchObject({ code: "validation" });
    aiMock.extract = () => ({ title: "  ", description: null, categorySlug: "does-not-exist", attributes: { ply: "3", junk: { a: 1 }, nan: NaN, ok: "y" }, pricePaise: -5, priceUnit: "u".repeat(50), moq: 0, moqUnit: null, hsn: "12ab", decisionId: "d", confidence: 0.2, needsReview: true });
    const d = await cat.draftListingFromText(s, "  kraft boxes for cosmetics  ", "xx");
    expect(d).toMatchObject({ title: "kraft boxes for cosmetics", description: "kraft boxes for cosmetics", language: "en", aiGenerated: true, status: "draft", pricePaise: null, moq: null, hsn: null });
    expect(d.priceUnit).toHaveLength(30);
    expect(d.attributes).not.toHaveProperty("junk");
    expect(d.attributes).not.toHaveProperty("nan");
    expect((await cat.listCategories()).find((c) => c.id === d.category.id)!.prohibited).toBe(false);
    aiMock.extract = () => ({ title: "T", description: "D", categorySlug: `lc-a-${tag}`, attributes: {}, pricePaise: 1999.9, priceUnit: "kg", moq: 50.7, moqUnit: "kg", hsn: "6109", decisionId: "d", confidence: 0.9, needsReview: false });
    const e = await cat.draftListingFromText(s, "cotton fabric", "hi");
    expect(e).toMatchObject({ category: { slug: `lc-a-${tag}` }, pricePaise: 1999, moq: 50, hsn: "6109", language: "hi" });
    aiMock.extract = null;
  });
  it("public seller/index/featured/count reads", async () => {
    const s = await mkSeller(2, 90, "pub");
    // versions.db.test.ts runs publishDueVersions() (a global sweep) in a parallel worker against the same DB: it can pick up
    // our approved version and hold the row lock, so our publishVersion() returns "skipped" before the sweeper commits. Wait
    // until the listing is really published (authoring commit) and re-bust the seller cache so a read that raced the sweeper
    // can't have cached a partial list.
    const mkp = async (t: string, extra = {}) => {
      const l = await cat.createListing(s, input(t, extra));
      await cat.publishVersion((await cat.submitListingVersion(s, l.id)).id);
      for (let i = 0; i < 100; i++) {
        if ((await prisma.listing.findUnique({ where: { id: l.id }, select: { status: true } }))?.status === "published") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await invalidateTags([cacheTags.sellerListings(s), cacheTags.listing(l.id)]);
      return l.id;
    };
    const a = await mkp("PUB complete", { pricePaise: 100, moq: 5 });
    await new Promise((r) => setTimeout(r, 20));
    const b = await mkp("PUB bare", { pricePaise: null, moq: null });
    expect((await cat.listPublicSellerListings(s)).map((x) => x.id)).toEqual([b, a]); // newest first
    expect(await cat.listPublicSellerListings("bad")).toEqual([]);
    await invalidateTags([cacheTags.featured]); // featured rails are only soft-invalidated on publish (stale-while-revalidate)
    const fresh = await cat.listFeaturedListings({ sort: "new", limit: 50 });
    expect(fresh.map((x) => x.id)).toEqual(expect.arrayContaining([b]));
    expect(fresh.every((x) => x.status === "published" && x.moderationStatus === "approved")).toBe(true);
    expect((await cat.listFeaturedListings({ sort: "popular", limit: 1 })).length).toBe(1);
    expect((await cat.listFeaturedListings({ sort: "popular", limit: 9999 })).length).toBeLessThanOrEqual(50);
    const n = await cat.countPublicListings();
    expect(n).toBeGreaterThanOrEqual(2);
    const idx = await cat.listPublicListingIndex({ offset: 0, limit: 10_000 });
    expect(idx.map((x) => x.id)).toEqual(expect.arrayContaining([a, b]));
    expect(idx.find((x) => x.id === a)).toMatchObject({ categorySlug: `lc-a-${tag}` });
    expect(await cat.listPublicListingIndex({ offset: -5, limit: 0 })).toHaveLength(1);
  });
});

describe("previews", () => {
  it("token preview for a deleted/unknown version is null; preview status mapping; seller-scoped preview for foreign version is forbidden", async () => {
    const s = await mkSeller(0, 0, "prev");
    const l = await cat.createListing(s, input("PREV widget"));
    const v = await cat.submitListingVersion(s, l.id);
    const p = await cat.getVersionPreview(s, v.id);
    expect(p).toMatchObject({ moderationStatus: "review", status: "draft", preview: { versionStatus: "in_review", seller: { verificationTier: 0 } } });
    await cat.reviewListingVersion(v.id, "rejected", "bad photos", staff);
    expect(await cat.getVersionPreview(s, v.id)).toMatchObject({ moderationStatus: "rejected", moderationReason: "bad photos" });
    expect(await cat.getPreviewByToken(cat.createPreviewToken(randomUUID()))).toBeNull(); // valid signature, no such version
    await expect(cat.getVersionPreview(s, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    const t = cat.createPreviewToken(v.id, Date.now() - 2 * 3600_000);
    expect(await cat.getPreviewByToken(t)).toBeNull(); // expired
    // preview of an old version shows the old snapshot even after edits
    expect((await cat.getPreviewByToken(cat.createPreviewToken(v.id)))!.title).toBe(`PREV widget ${tag}`);
    await cat.updateListing(s, l.id, { title: `PREV changed ${tag}` });
    expect((await cat.getPreviewByToken(cat.createPreviewToken(v.id)))!.title).toBe(`PREV widget ${tag}`);
  });
});
