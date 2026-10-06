import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIM, prisma } from "@cnote/db";
import { liveDb } from "@cnote/live-db";

const vec = (axis: number) => Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === axis ? 1 : 0));
vi.mock("@cnote/ai", () => ({
  embed: async (texts: string[]) => ({ vectors: texts.map(() => vec(0)), version: "test-v1" }),
  enqueueReview: async () => undefined,
  moderate: async (i: { text: string }) => ({ verdict: /gun/i.test(i.text) ? "block" : "allow", flags: [], reason: /gun/i.test(i.text) ? "weapons" : null, decisionId: "d", confidence: 0.9, needsReview: false, deterministic: "clean" }),
}));
process.env.LISTING_AUTO_APPROVE_MIN_HUMAN_APPROVED = "0";
process.env.LISTING_AUTO_APPROVE_SAMPLE_RATE = "0";
const OLD = new Date(Date.now() - 90 * 86_400_000);
const cat = await import("../src/index");
const tag = randomUUID().slice(0, 8);
let catId = "";
let plainCatId = "";
let seller = "";
let other = "";

const input = (title: string, extra: Record<string, unknown> = {}) => ({
  categoryId: catId, title: `${title} ${tag}`, description: `${title} description long enough ${tag}`, attributes: {},
  pricePaise: 1000, priceUnit: "piece", moq: 10, moqUnit: "piece", hsn: null, language: "en", imageUrls: [], ...extra,
});
const variant = (sku: string, size: string, colour: string, extra: Record<string, unknown> = {}) => ({ sku: `${sku}-${tag}`, axisValues: { size, colour }, ...extra });
const types = (id: string) => prisma.domainEvent.findMany({ where: { aggregateId: id }, orderBy: { id: "asc" } });
const availEvents = async (id: string) => (await types(id)).filter((e) => e.type === "ListingAvailabilityChanged").map((e) => e.payload as { fromAvailability: string; toAvailability: string; variantId: string | null });
const liveRow = (id: string) => liveDb.liveListing.findUniqueOrThrow({ where: { id } });

async function publishNew(extra: Record<string, unknown> = {}, variants: ReturnType<typeof variant>[] = []) {
  const l = await cat.createListing(seller, input(`Shirt ${randomUUID().slice(0, 4)}`, extra));
  if (variants.length) await cat.setListingVariants(seller, l.id, variants);
  const v = await cat.submitListingVersion(seller, l.id, {});
  expect(await cat.publishVersion(v.id)).toBe("published");
  return l.id;
}

beforeAll(async () => {
  const [c, p] = await cat.upsertCategories([
    { slug: `t-var-${tag}`, name: "Test Variants", attributeSchema: { fields: [], variantAxes: [{ key: "size", label: "Size", options: ["S", "M", "L"] }, { key: "colour", label: "Colour" }] } },
    { slug: `t-novar-${tag}`, name: "Test No Variants", attributeSchema: { fields: [] } },
  ]);
  catId = c!.id;
  plainCatId = p!.id;
  seller = (await prisma.business.create({ data: { name: `Var Seller ${tag}`, isSeller: true, verificationTier: 2, trustScore: 80, createdAt: OLD } })).id;
  other = (await prisma.business.create({ data: { name: `Other ${tag}`, isSeller: true } })).id;
});

afterAll(async () => {
  const ids = (await prisma.listing.findMany({ where: { sellerBusinessId: { in: [seller, other] } }, select: { id: true } })).map((l) => l.id);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } }).catch(() => {});
  await liveDb.liveListing.deleteMany({ where: { id: { in: ids } } });
  await prisma.listing.updateMany({ where: { id: { in: ids } }, data: { liveVersionId: null } });
  await prisma.listingVersion.deleteMany({ where: { listingId: { in: ids } } });
  await prisma.listingPriceHistory.deleteMany({ where: { listing: { id: { in: ids } } } }).catch(() => {});
  await prisma.listing.deleteMany({ where: { id: { in: ids } } });
  await prisma.business.deleteMany({ where: { id: { in: [seller, other] } } });
  await prisma.category.deleteMany({ where: { slug: { endsWith: tag } } }).catch(() => {});
});

describe("listing stock", () => {
  it("defaults to in_stock, validates made_to_order lead time and stores the stock timestamp", async () => {
    const l = await cat.createListing(seller, input("Plain stock"));
    expect(l).toMatchObject({ availability: "in_stock", ownAvailability: "in_stock", availableQty: null, stockUpdatedAt: null, variants: [] });
    await expect(cat.createListing(seller, input("MTO no lead", { availability: "made_to_order" }))).rejects.toMatchObject({ code: "validation" });
    const mto = await cat.createListing(seller, input("MTO", { availability: "made_to_order", trade: { leadTimeDays: 12 } }));
    expect(mto).toMatchObject({ availability: "made_to_order", trade: { leadTimeDays: 12 } });
    expect(mto.stockUpdatedAt).not.toBeNull();
    await expect(cat.updateListing(seller, mto.id, { trade: {} })).rejects.toMatchObject({ code: "validation" }); // would leave made_to_order without a lead time
    await expect(cat.updateListingStock(seller, l.id, { availability: "out_of_stock", availableQty: 4 })).rejects.toMatchObject({ code: "validation" });
    await expect(cat.updateListingStock(other, l.id, { availability: "out_of_stock" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("projects to LIVE and the fast path updates LIVE at once, without a new version, and emits real transitions only", async () => {
    const id = await publishNew({ availableQty: 40 });
    expect(await cat.getPublicListing(id)).toMatchObject({ availability: "in_stock", availableQty: 40, variants: [] });
    const versionsBefore = await prisma.listingVersion.count({ where: { listingId: id } });

    const out = await cat.updateListingStock(seller, id, { availability: "out_of_stock" });
    expect(out).toMatchObject({ availability: "out_of_stock", availableQty: null });
    expect(await cat.getPublicListing(id)).toMatchObject({ availability: "out_of_stock" });
    expect((await liveRow(id)).availability).toBe("out_of_stock");
    expect(await prisma.listingVersion.count({ where: { listingId: id } })).toBe(versionsBefore); // no review for stock

    // made-to-order needs a lead time; supplying it writes it to LIVE too
    await expect(cat.updateListingStock(seller, id, { availability: "made_to_order" })).rejects.toMatchObject({ code: "validation" });
    await cat.updateListingStock(seller, id, { availability: "made_to_order", leadTimeDays: 14 });
    expect(await cat.getPublicListing(id)).toMatchObject({ availability: "made_to_order", trade: { leadTimeDays: 14 } });
    await cat.updateListingStock(seller, id, { availability: "in_stock", availableQty: 25 });
    await cat.updateListingStock(seller, id, { availability: "in_stock", availableQty: 25 }); // no change: nothing emitted
    expect((await availEvents(id)).map((e) => [e.fromAvailability, e.toAvailability])).toEqual([["in_stock", "out_of_stock"], ["out_of_stock", "made_to_order"], ["made_to_order", "in_stock"]]);
  });

  it("a stock-only change is not content: submit still says nothing changed", async () => {
    const id = await publishNew();
    await cat.updateListingStock(seller, id, { availability: "out_of_stock" });
    await cat.updateListingStock(seller, id, { availability: "in_stock", availableQty: 7 });
    await expect(cat.submitListingVersion(seller, id, {})).rejects.toMatchObject({ code: "conflict" });
  });

  it("updateListing routes stock fields through the fast path", async () => {
    const id = await publishNew();
    const r = await cat.updateListing(seller, id, { availability: "out_of_stock" });
    expect(r.availability).toBe("out_of_stock");
    expect((await liveRow(id)).availability).toBe("out_of_stock");
    expect(await availEvents(id)).toHaveLength(1);
  });

  it("a publish carries the CURRENT stock, not the stock frozen at submit time", async () => {
    const id = await publishNew();
    await cat.updateListing(seller, id, { title: `Renamed ${tag}` });
    const v2 = await cat.submitListingVersion(seller, id, {});
    await cat.updateListingStock(seller, id, { availability: "out_of_stock" }); // toggled after submit, before publish
    expect(await cat.publishVersion(v2.id)).toBe("published");
    expect(await cat.getPublicListing(id)).toMatchObject({ title: `Renamed ${tag}`, availability: "out_of_stock" });
  });

  it("a publish that changes the effective stock emits ListingAvailabilityChanged", async () => {
    const id = await publishNew({}, [variant("P1", "S", "Red", { availability: "out_of_stock" })]);
    expect(await cat.getPublicListing(id)).toMatchObject({ availability: "out_of_stock" });
    await cat.setListingVariants(seller, id, [variant("P1", "S", "Red", { availability: "out_of_stock" }), variant("P2", "M", "Red")]); // new in-stock variant, not live yet
    expect(await cat.getPublicListing(id)).toMatchObject({ availability: "out_of_stock" });
    const v2 = await cat.submitListingVersion(seller, id, {});
    await cat.publishVersion(v2.id);
    expect(await cat.getPublicListing(id)).toMatchObject({ availability: "in_stock" });
    expect((await availEvents(id)).map((e) => [e.fromAvailability, e.toAvailability])).toEqual([["out_of_stock", "in_stock"]]);
  });

  it("reprojectStock heals a LIVE row that drifted from the working copy, without an event", async () => {
    const id = await publishNew();
    await prisma.listing.update({ where: { id }, data: { availability: "out_of_stock" } }); // simulated crash between the writes
    expect((await liveRow(id)).availability).toBe("in_stock");
    expect(await cat.reprojectStock(id)).toBe(true);
    expect((await liveRow(id)).availability).toBe("out_of_stock");
    expect(await cat.reprojectStock(id)).toBe(false);
    expect(await availEvents(id)).toHaveLength(0);
  });
});

describe("variants", () => {
  it("rejects variants in a category without axes, bad axes and foreign images", async () => {
    const l = await cat.createListing(seller, input("No axes", { categoryId: plainCatId }));
    await expect(cat.setListingVariants(seller, l.id, [{ sku: "A", axisValues: { size: "S" } }])).rejects.toMatchObject({ code: "validation" });
    const v = await cat.createListing(seller, input("Axes"));
    await expect(cat.setListingVariants(seller, v.id, [{ sku: "A", axisValues: { size: "XXL", colour: "Red" } }])).rejects.toMatchObject({ code: "validation" });
    await expect(cat.setListingVariants(seller, v.id, [{ ...variant("A", "S", "Red"), imageId: randomUUID() }])).rejects.toMatchObject({ code: "validation" });
    await expect(cat.setListingVariants(other, v.id, [])).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps ids stable across edits (match by id, then sku), supports sku swaps and deletes the rest", async () => {
    const l = await cat.createListing(seller, input("Matrix"));
    const first = await cat.setListingVariants(seller, l.id, [variant("A", "S", "Red"), variant("B", "M", "Red"), variant("C", "L", "Red")]);
    expect(first.map((x) => x.sortOrder)).toEqual([0, 1, 2]);
    const [a, b, c] = first;
    const second = await cat.setListingVariants(seller, l.id, [
      { ...variant("B", "M", "Red"), id: a!.id, sku: `B-${tag}` }, // a's row now carries b's sku ...
      { ...variant("A", "S", "Red"), id: b!.id, sku: `A-${tag}` }, // ... and vice versa (swap)
      variant("C", "L", "Blue"), // matched by sku
      variant("D", "S", "Blue"), // new
    ]);
    expect(second.map((x) => x.sku)).toEqual([`B-${tag}`, `A-${tag}`, `C-${tag}`, `D-${tag}`]);
    expect(second[0]!.id).toBe(a!.id);
    expect(second[2]!.id).toBe(c!.id);
    expect(second[2]!.axisValues).toEqual({ size: "L", colour: "Blue" });
    const third = await cat.setListingVariants(seller, l.id, [variant("D", "S", "Blue")]);
    expect(third).toHaveLength(1);
    expect(await prisma.listingVariant.count({ where: { listingId: l.id } })).toBe(1);
    expect(await cat.setListingVariants(seller, l.id, [])).toEqual([]);
  });

  it("covers variants in versions: snapshot, diff, moderation, LIVE projection and the public view", async () => {
    const id = await publishNew({}, [variant("V1", "S", "Red", { priceTiers: [{ minQty: 10, pricePaise: 900 }] }), variant("V2", "M", "Blue", { pricePaise: 1500, moq: 5, availability: "made_to_order", leadTimeDays: 10 })]);
    const pub = await cat.getPublicListing(id);
    expect(pub!.variantAxes).toEqual([{ key: "size", label: "Size" }, { key: "colour", label: "Colour" }]);
    expect(pub!.variants!.map((x) => [x.sku, x.availability, x.pricePaise, x.moq])).toEqual([[`V1-${tag}`, "in_stock", null, null], [`V2-${tag}`, "made_to_order", 1500, 5]]);
    const live = await liveRow(id);
    expect(live.variantValues).toEqual(["colour:blue", "colour:red", "size:m", "size:s"]);
    expect(live.availability).toBe("in_stock");

    // a structure change is a content change: it needs a version
    await cat.setListingVariants(seller, id, [variant("V1", "S", "Red", { priceTiers: [{ minQty: 10, pricePaise: 800 }] }), variant("V2", "M", "Blue", { pricePaise: 1500, moq: 5, availability: "made_to_order", leadTimeDays: 10 }), variant("V3", "L", "Blue")]);
    expect((await cat.getPublicListing(id))!.variants).toHaveLength(2);
    const ov = await cat.getVersionOverview(seller, id);
    expect(ov.unsubmittedChanges.map((c) => c.field).sort()).toEqual([`variants.V1-${tag}`, `variants.V3-${tag}`]);
    const v2 = await cat.submitListingVersion(seller, id, {});
    expect(v2.snapshot.variants).toHaveLength(3);
    await cat.publishVersion(v2.id);
    expect((await cat.getPublicListing(id))!.variants).toHaveLength(3);

    // variant text is moderated: a blocked word in a variant SKU rejects the version
    await cat.setListingVariants(seller, id, [variant("GUN", "S", "Red")]);
    const bad = await cat.submitListingVersion(seller, id, {});
    expect(bad.status).toBe("rejected");
    expect((await cat.getPublicListing(id))!.variants).toHaveLength(3); // live untouched
  });

  it("variant stock rolls up: the listing is in stock while any variant is; the last one flipping fires the events", async () => {
    const id = await publishNew({}, [variant("R1", "S", "Red"), variant("R2", "M", "Red")]);
    await cat.updateListingStock(seller, id, { variants: [{ sku: `R1-${tag}`, availability: "out_of_stock" }] });
    expect((await liveRow(id)).availability).toBe("in_stock");
    expect(await availEvents(id)).toHaveLength(0);
    await cat.updateListingStock(seller, id, { variants: [{ sku: `R2-${tag}`, availability: "out_of_stock" }] });
    expect((await liveRow(id)).availability).toBe("out_of_stock");
    const pub = await cat.getPublicListing(id);
    expect(pub!.variants!.map((x) => x.availability)).toEqual(["out_of_stock", "out_of_stock"]);
    await cat.updateListingStock(seller, id, { variants: [{ sku: `R1-${tag}`, availability: "made_to_order", leadTimeDays: 5 }] });
    expect((await availEvents(id)).map((e) => [e.fromAvailability, e.toAvailability])).toEqual([["in_stock", "out_of_stock"], ["out_of_stock", "made_to_order"]]);
    expect((await availEvents(id))[1]!.variantId).not.toBeNull();
    await expect(cat.updateListingStock(seller, id, { variants: [{ sku: "nope", availability: "in_stock" }] })).rejects.toMatchObject({ code: "validation" });
    await expect(cat.updateListingStock(seller, id, { variants: [{ sku: `R2-${tag}`, availability: "made_to_order" }] })).rejects.toMatchObject({ code: "validation" }); // no lead time anywhere
  });

  it("a stock edit made in the variant matrix reaches LIVE immediately, a new variant does not", async () => {
    const id = await publishNew({}, [variant("M1", "S", "Red")]);
    await cat.setListingVariants(seller, id, [variant("M1", "S", "Red", { availability: "out_of_stock" }), variant("M2", "M", "Red")]);
    const pub = await cat.getPublicListing(id);
    expect(pub!.variants!.map((x) => [x.sku, x.availability])).toEqual([[`M1-${tag}`, "out_of_stock"]]);
    expect(pub!.availability).toBe("out_of_stock");
  });

  it("refuses a category change that orphans the variants", async () => {
    const l = await cat.createListing(seller, input("Cat change"));
    await cat.setListingVariants(seller, l.id, [variant("X", "S", "Red")]);
    await expect(cat.updateListing(seller, l.id, { categoryId: plainCatId })).rejects.toMatchObject({ code: "validation" });
  });

  it("submit refuses a made-to-order listing without a lead time", async () => {
    const l = await cat.createListing(seller, input("Submit MTO", { availability: "made_to_order", trade: { leadTimeDays: 3 } }));
    await prisma.listing.update({ where: { id: l.id }, data: { leadTimeDays: null } }); // bypass the write-time check
    await expect(cat.submitListingVersion(seller, l.id, {})).rejects.toMatchObject({ code: "validation" });
  });
});

describe("retrieval filters", () => {
  it("'in stock only' and variant options narrow results without touching ordering inputs", async () => {
    const word = `fltr${tag}`;
    const a = await publishNew({ title: `${word} a` }, [variant("F1", "S", "Red"), variant("F2", "M", "Blue")]);
    const b = await publishNew({ title: `${word} b` }, [variant("G1", "L", "Red", { availability: "out_of_stock" })]);
    const ask = async (filters: object) => (await cat.retrieveListings({ text: word, filters, limit: 50 })).map((r) => r.listingId).sort();
    const both = [a, b].sort();
    expect(await ask({})).toEqual(both);
    expect(await ask({ inStockOnly: true })).toEqual([a]);
    expect(await ask({ variantOptions: { size: ["m", "l"] } })).toEqual(both);
    expect(await ask({ variantOptions: { size: ["l"], colour: ["red"] } })).toEqual([b]);
    expect(await ask({ variantOptions: { size: ["l"], colour: ["blue"] } })).toEqual([]);
    expect(await ask({ inStockOnly: true, variantOptions: { colour: ["red"] } })).toEqual([a]);
    const facets = await cat.retrieveFacetRows({ text: word });
    expect(facets.flatMap((r) => r.variantValues)).toEqual(expect.arrayContaining(["size:s", "size:m", "size:l", "colour:red"]));
    expect(facets.map((r) => r.availability).sort()).toEqual(["in_stock", "out_of_stock"]);
  });
});
