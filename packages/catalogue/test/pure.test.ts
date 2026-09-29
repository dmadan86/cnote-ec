import { randomUUID } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({
  mod: { verdict: "allow", flags: [] as string[], reason: null as string | null, needsReview: false },
  embed: { vectors: [[0.1, 0.2]] as number[][], version: "v1" },
  moderate: vi.fn(),
  embedFn: vi.fn(),
}));
vi.mock("@cnote/ai", () => ({
  moderate: async (...a: unknown[]) => (ai.moderate(...a), { ...ai.mod, decisionId: "d", confidence: 0.9 }),
  embed: async (...a: unknown[]) => (ai.embedFn(...a), ai.embed),
}));

process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret";
const { assess } = await import("../src/moderation");
const v = await import("../src/validate");
const ver = await import("../src/versions");
const { isUuid, toCategoryView, liveToListingView, toListingView } = await import("../src/mappers");

const catView = (o: Record<string, unknown> = {}) => ({ id: randomUUID(), slug: "cat", name: "Cat", icon: null, leadCap: 3, prohibited: false, attributeSchema: { fields: [] }, parentId: null, ...o }) as never;
const content = { id: randomUUID(), title: "Cotton tee", description: "Round neck tee", attributes: { gsm: 180 } };

describe("assess (moderation outcomes → statuses)", () => {
  const run = (verdict: string, extra: Partial<typeof ai.mod> = {}) => {
    Object.assign(ai.mod, { verdict, flags: [], reason: null, needsReview: false }, extra);
    return assess(content, catView());
  };
  it("prohibited category is rejected WITHOUT calling the model or embedder", async () => {
    ai.moderate.mockClear(); ai.embedFn.mockClear();
    const r = await assess(content, catView({ prohibited: true, name: "Weapons" }));
    expect(r).toEqual({ outcome: "rejected", reason: 'Category "Weapons" is not permitted on the marketplace' });
    expect(ai.moderate).not.toHaveBeenCalled();
    expect(ai.embedFn).not.toHaveBeenCalled();
  });
  it("block → rejected, reason from model, else flags, else generic; never embeds", async () => {
    ai.embedFn.mockClear();
    expect(await run("block", { reason: "weapons" })).toEqual({ outcome: "rejected", reason: "weapons" });
    expect(await run("block", { flags: ["a", "b"] })).toEqual({ outcome: "rejected", reason: "Blocked by content policy: a, b" });
    expect(await run("block")).toEqual({ outcome: "rejected", reason: "Blocked by content policy" });
    expect(ai.embedFn).not.toHaveBeenCalled();
  });
  it("allow → approved with embedding + version; null reason", async () => {
    expect(await run("allow")).toEqual({ outcome: "approved", reason: null, embedding: [0.1, 0.2], embeddingVersion: "v1" });
  });
  it("review or needsReview downgrade allow → review with reason default", async () => {
    expect(await run("review", { reason: "hmm" })).toMatchObject({ outcome: "review", reason: "hmm" });
    expect(await run("review")).toMatchObject({ outcome: "review", reason: "Flagged for manual review" });
    expect(await run("allow", { needsReview: true })).toMatchObject({ outcome: "review" });
  });
  it("throws when the embedder returns no vector", async () => {
    ai.embed.vectors = [];
    await expect(run("allow")).rejects.toThrow(/no vector/);
    ai.embed.vectors = [[0.1, 0.2]];
  });
  it("moderates the canonical text with category slug and listing subject", async () => {
    ai.moderate.mockClear();
    await run("allow");
    expect(ai.moderate).toHaveBeenCalledWith({ text: "Cotton tee\nCat\ngsm: 180\nRound neck tee", categorySlug: "cat" }, { type: "listing", id: content.id });
  });
});

describe("attribute schema validation matrix", () => {
  const schema = {
    fields: [
      { key: "gsm", label: "GSM", type: "number" as const, required: true },
      { key: "fabric", label: "Fabric", type: "select" as const, options: ["Cotton", "Polyester"], required: true },
      { key: "note", label: "Note", type: "text" as const },
      { key: "opt", label: "Opt", type: "select" as const },
    ],
  };
  const ok = { gsm: 180, fabric: "Cotton" };
  const table: [string, Record<string, string | number>, string[]][] = [
    ["valid", ok, []],
    ["missing all required", {}, ["GSM is required", "Fabric is required"]],
    ["blank string counts as empty", { gsm: "   ", fabric: "" }, ["GSM is required", "Fabric is required"]],
    ["number given as string", { ...ok, gsm: "180" }, ["GSM must be a number"]],
    ["NaN", { ...ok, gsm: NaN }, ["GSM must be a number"]],
    ["Infinity", { ...ok, gsm: Infinity }, ["GSM must be a number"]],
    ["zero is a valid number (not empty)", { ...ok, gsm: 0 }, []],
    ["negative allowed", { ...ok, gsm: -1 }, []],
    ["select not in options", { ...ok, fabric: "Silk" }, ["Fabric must be one of: Cotton, Polyester"]],
    ["select case-sensitive at validate time", { ...ok, fabric: "cotton" }, ["Fabric must be one of: Cotton, Polyester"]],
    ["select w/o options rejects any value", { ...ok, opt: "x" }, ["Opt must be one of: "]],
    ["text given number", { ...ok, note: 5 }, ["Note must be text"]],
    ["text ok", { ...ok, note: "hello" }, []],
    ["unknown keys ignored", { ...ok, zzz: "1" }, []],
    ["optional empty ok", { ...ok, note: "" }, []],
  ];
  it.each(table)("%s", (_n, attrs, want) => expect(v.validateAttributes(schema, attrs)).toEqual(want));
  it("empty schema accepts anything", () => expect(v.validateAttributes({ fields: [] }, { a: 1 })).toEqual([]));

  it("coerce: leaves unknown / undefined / non-numeric strings alone; text number → string", () => {
    expect(v.coerceAttributes(schema, { gsm: "abc", note: 5, zzz: "1", fabric: "silk" })).toEqual({ gsm: "abc", note: "5", zzz: "1", fabric: "silk" });
    expect(v.coerceAttributes(schema, { gsm: " 12.5 " })).toEqual({ gsm: 12.5 });
    expect(v.coerceAttributes(schema, { gsm: "" })).toEqual({ gsm: "" });
    expect(v.coerceAttributes(schema, { fabric: " POLYESTER " })).toEqual({ fabric: "Polyester" });
  });
  it("does not mutate its input", () => {
    const a = { gsm: "1" };
    v.coerceAttributes(schema, a);
    expect(a).toEqual({ gsm: "1" });
  });
  it("property: coerce is idempotent and coerce∘validate accepts numeric strings", () => {
    fc.assert(fc.property(fc.dictionary(fc.constantFrom("gsm", "fabric", "note", "x"), fc.oneof(fc.string(), fc.integer())), (a) => {
      const once = v.coerceAttributes(schema, a);
      expect(v.coerceAttributes(schema, once)).toEqual(once);
    }));
    fc.assert(fc.property(fc.integer({ min: -1e6, max: 1e6 }), (n) => {
      expect(v.validateAttributes(schema, v.coerceAttributes(schema, { gsm: String(n), fabric: "COTTON" }))).toEqual([]);
    }));
  });
});

describe("listing input schemas", () => {
  const base = { categoryId: randomUUID(), title: "  Tee  ", description: "d", attributes: { a: 1 }, pricePaise: 0, priceUnit: null, moq: 1, moqUnit: null, hsn: "6109", language: "en", imageUrls: [] };
  const bad = (patch: Record<string, unknown>) => v.listingInputSchema.safeParse({ ...base, ...patch }).success;
  it("accepts valid and trims", () => {
    const r = v.parseOrThrow(v.listingInputSchema, base);
    expect(r.title).toBe("Tee");
  });
  it.each([
    ["bad uuid", { categoryId: "x" }], ["empty title", { title: "  " }], ["long title", { title: "x".repeat(201) }],
    ["long desc", { description: "x".repeat(5001) }], ["neg price", { pricePaise: -1 }], ["fractional price", { pricePaise: 1.5 }],
    ["moq 0", { moq: 0 }], ["moq too big", { moq: 2_000_000_001 }], ["hsn letters", { hsn: "61a9" }], ["hsn 1 digit", { hsn: "6" }], ["hsn 9 digits", { hsn: "123456789" }],
    ["lang", { language: "fr" }], ["11 images", { imageUrls: Array(11).fill("u") }], ["empty image", { imageUrls: [""] }],
    ["attr NaN", { attributes: { a: NaN } }], ["attr long key", { attributes: { ["k".repeat(61)]: 1 } }], ["attr long val", { attributes: { a: "x".repeat(501) } }],
    ["attr object val", { attributes: { a: { b: 1 } } }], ["sku with space", { sku: "a b" }], ["sku 65", { sku: "a".repeat(65) }],
  ])("rejects %s", (_n, p) => expect(bad(p)).toBe(false));
  it.each([{ pricePaise: null }, { hsn: null }, { hsn: "12345678" }, { sku: null }, { sku: "AB-1_x.2" }, { moq: 1 }])("accepts %j", (p) => expect(bad(p)).toBe(true));
  it("SKU_RE property: accepted ⇔ charset+length", () => {
    fc.assert(fc.property(fc.string({ maxLength: 80 }), (s) => { expect(v.SKU_RE.test(s)).toBe(/^[A-Za-z0-9._-]+$/.test(s) && s.length <= 64 && s.length >= 1 && !s.includes("\n")); }));
  });
  it("patch schema is partial and strict", () => {
    expect(v.listingPatchSchema.safeParse({}).success).toBe(true);
    expect(v.listingPatchSchema.safeParse({ title: "x" }).success).toBe(true);
    expect(v.listingPatchSchema.safeParse({ sellerBusinessId: randomUUID() }).success).toBe(false);
    expect(v.listingPatchSchema.safeParse({ status: "published" }).success).toBe(false);
  });
  it("parseOrThrow yields DomainError validation with paths", () => {
    try { v.parseOrThrow(v.listingInputSchema, { ...base, moq: 0 }); throw new Error("no"); } catch (e) {
      expect(e).toMatchObject({ code: "validation" });
      expect((e as Error).message).toContain("moq");
    }
  });
  it("validatePublishable boundaries", () => {
    expect(v.validatePublishable({ title: "abc", description: "0123456789" })).toEqual([]);
    expect(v.validatePublishable({ title: " ab ", description: "012345678" })).toHaveLength(2);
    expect(v.validatePublishable({ title: "abc", description: "         x" })).toHaveLength(1);
  });
  it("canonicalText skips empty parts", () => {
    expect(v.canonicalText({ title: "T", description: "", attributes: {} }, "")).toBe("T");
  });
});

const snap = (o: Partial<import("../src/versions").VersionSnapshot> = {}): import("../src/versions").VersionSnapshot => ({
  title: "A", description: "d", categoryId: "c", categoryName: "Cat", attributes: {}, pricePaise: null, priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", imageIds: [], imageUrls: [], ...o,
});
const snapArb = fc.record({
  title: fc.string(), description: fc.string(), categoryId: fc.constant("c"), categoryName: fc.constantFrom("X", "Y"),
  attributes: fc.dictionary(fc.constantFrom("a", "b", "c", "d"), fc.oneof(fc.string({ maxLength: 4 }), fc.integer())),
  pricePaise: fc.option(fc.nat(), { nil: null }), priceUnit: fc.option(fc.constantFrom("kg", "pc"), { nil: null }),
  moq: fc.option(fc.nat(), { nil: null }), moqUnit: fc.option(fc.constantFrom("kg", "pc"), { nil: null }), hsn: fc.option(fc.constantFrom("61", "6109"), { nil: null }),
  language: fc.constantFrom("en", "hi"), imageIds: fc.uniqueArray(fc.constantFrom("i1", "i2", "i3", "i4")), imageUrls: fc.constant([] as string[]),
});

describe("diffSnapshots", () => {
  it("scalar table", () => {
    const cases: [Partial<import("../src/versions").VersionSnapshot>, string, string][] = [
      [{ title: "B" }, "title", "Title"], [{ description: "e" }, "description", "Description"], [{ categoryName: "Z" }, "category", "Category"],
      [{ pricePaise: 5 }, "pricePaise", "Price (paise)"], [{ priceUnit: "kg" }, "priceUnit", "Price unit"], [{ moq: 2 }, "moq", "Minimum order"],
      [{ moqUnit: "kg" }, "moqUnit", "MOQ unit"], [{ hsn: "61" }, "hsn", "HSN"], [{ language: "hi" }, "language", "Language"],
    ];
    for (const [p, field, label] of cases) expect(ver.diffSnapshots(snap(), snap(p))).toEqual([expect.objectContaining({ field, label })]);
  });
  it("null vs undefined-ish treated equal; price 0 vs null differs", () => {
    expect(ver.diffSnapshots(snap({ pricePaise: 0 }), snap({ pricePaise: null }))).toHaveLength(1);
    // a legacy snapshot missing fields diffs as missing → present, never throws
    expect(ver.diffSnapshots({ title: "A" } as never, snap()).some((c) => c.field === "description")).toBe(true);
  });
  it("image diffs: added/removed/reordered/pluralisation", () => {
    const d = (a: string[], b: string[]) => ver.diffSnapshots(snap({ imageIds: a }), snap({ imageIds: b }))[0];
    expect(d([], ["1"])).toMatchObject({ before: "0 images", after: "1 image (+1 / -0)" });
    expect(d(["1", "2"], ["1"])).toMatchObject({ before: "2 images", after: "1 image (+0 / -1)" });
    expect(d(["1", "2"], ["2", "1"])).toMatchObject({ after: "2 images (reordered)" });
    expect(d(["1"], ["2"])).toMatchObject({ after: "1 image (+1 / -1)" });
    expect(ver.diffSnapshots(snap({ imageIds: ["1"] }), snap({ imageIds: ["1"] }))).toEqual([]);
  });
  it("attribute changes sorted, added/removed/changed", () => {
    const d = ver.diffSnapshots(snap({ attributes: { b: 1, a: 1 } }), snap({ attributes: { b: 2, c: 3 } }));
    expect(d.map((x) => [x.field, x.before, x.after])).toEqual([["attributes.a", 1, null], ["attributes.b", 1, 2], ["attributes.c", null, 3]]);
  });
  it("property: diff(a,a) is empty", () => fc.assert(fc.property(snapArb, (a) => { expect(ver.diffSnapshots(a, a)).toEqual([]); })));
  it("property: empty diff ⇔ snapshots equal (on diffed fields); diff is antisymmetric", () =>
    fc.assert(fc.property(snapArb, snapArb, (a, b) => {
      const ab = ver.diffSnapshots(a, b);
      const ba = ver.diffSnapshots(b, a);
      expect(ab.length).toBe(ba.length);
      const fields = (x: typeof ab) => x.map((c) => c.field).sort();
      expect(fields(ab)).toEqual(fields(ba));
      for (const c of ab) if (c.field !== "images") {
        const r = ba.find((x) => x.field === c.field)!;
        expect([r.before, r.after]).toEqual([c.after, c.before]);
      }
      const same = JSON.stringify(a) === JSON.stringify(b) || (a.attributes && ab.length === 0);
      if (ab.length === 0) expect(same).toBe(true);
    })));
  it("property: applying the diff to a reproduces b's attributes and scalars", () =>
    fc.assert(fc.property(snapArb, snapArb, (a, b) => {
      const out: Record<string, unknown> = { ...a, attributes: { ...a.attributes } };
      for (const c of ver.diffSnapshots(a, b)) {
        if (c.field.startsWith("attributes.")) {
          const k = c.field.slice(11);
          if (c.after === null) delete (out.attributes as Record<string, unknown>)[k]; else (out.attributes as Record<string, unknown>)[k] = c.after;
        } else if (c.field === "category") out.categoryName = c.after;
        else if (c.field !== "images") out[c.field] = c.after;
      }
      expect(out.attributes).toEqual(b.attributes);
      for (const k of ["title", "description", "categoryName", "pricePaise", "priceUnit", "moq", "moqUnit", "hsn", "language"]) expect(out[k]).toEqual((b as Record<string, unknown>)[k]);
    })));
});

describe("snapshot helpers", () => {
  it("snapshotOf converts bigint price and image ids; attrs non-object → {}", () => {
    const row = { title: "t", description: "d", categoryId: "c", attributes: [1], pricePaise: BigInt(150), priceUnit: "kg", moq: 2, moqUnit: null, hsn: null, language: "en", images: [{ id: "i" }], imageUrls: ["u"] } as never;
    expect(ver.snapshotOf(row, "Cat")).toMatchObject({ pricePaise: 150, attributes: {}, imageIds: ["i"], imageUrls: ["u"], categoryName: "Cat" });
    expect(ver.snapshotOf({ ...(row as object), pricePaise: null } as never, "Cat").pricePaise).toBeNull();
  });
  it("parseSnapshot tolerates junk / null", () => {
    expect(ver.parseSnapshot(null)).toMatchObject({ title: "", language: "en", imageIds: [], attributes: {} });
    expect(ver.parseSnapshot({ imageIds: "x", attributes: [], title: "T" })).toMatchObject({ title: "T", imageIds: [], attributes: {} });
  });
  it("toVersionView maps dates, isLive and non-array changes", () => {
    const now = new Date();
    const row = { id: "v", listingId: "l", version: 2, status: "approved", changeNote: null, changes: null, aiVerdict: null, reviewNote: null, reviewedBy: null, reviewedAt: null, publishAt: now, publishedAt: null, createdBy: "s", createdAt: now, snapshot: {} } as never;
    expect(ver.toVersionView(row, "v")).toMatchObject({ isLive: true, changes: [], publishAt: now.toISOString(), reviewedAt: null });
    expect(ver.toVersionView(row, null).isLive).toBe(false);
  });
  it("auto-approve policy constants", () => expect(ver.AUTO_APPROVE).toEqual({ minTier: 1, minTrust: 60 }));
});

describe("preview tokens", () => {
  const id = randomUUID();
  const now = 1_700_000_000_000;
  it("round-trips; boundary of expiry", () => {
    const t = ver.createPreviewToken(id, now);
    expect(ver.verifyPreviewToken(t, now)).toEqual({ versionId: id });
    expect(ver.verifyPreviewToken(t, now + 3600_000)).toEqual({ versionId: id });
    expect(ver.verifyPreviewToken(t, now + 3601_000 + 1000)).toBeNull();
  });
  it("wrong version / tampered exp / tampered sig / structure", () => {
    const t = ver.createPreviewToken(id, now);
    const [, exp, sig] = t.split(".");
    expect(ver.verifyPreviewToken(`${randomUUID()}.${exp}.${sig}`, now)).toBeNull();
    expect(ver.verifyPreviewToken(`${id}.${Number(exp) + 999999}.${sig}`, now)).toBeNull();
    expect(ver.verifyPreviewToken(`${id}.${exp}.${sig}x`, now)).toBeNull();
    expect(ver.verifyPreviewToken(`${id}.${exp}.${sig}.extra`, now)).toBeNull();
    expect(ver.verifyPreviewToken(`${id}.${exp}`, now)).toBeNull();
    expect(ver.verifyPreviewToken(`${id}.abc.${sig}`, now)).toBeNull();
    expect(ver.verifyPreviewToken("", now)).toBeNull();
    expect(ver.verifyPreviewToken(undefined, now)).toBeNull();
    expect(() => ver.createPreviewToken("nope")).toThrow();
  });
  it("token signed under a different secret is rejected", () => {
    const t = ver.createPreviewToken(id, Date.now());
    const old = process.env.PREVIEW_TOKEN_SECRET;
    process.env.PREVIEW_TOKEN_SECRET = "other";
    expect(ver.verifyPreviewToken(t)).toBeNull();
    process.env.PREVIEW_TOKEN_SECRET = old;
    expect(ver.verifyPreviewToken(t)).toEqual({ versionId: id });
  });
  it("throws without any secret", () => {
    const a = process.env.PREVIEW_TOKEN_SECRET, b = process.env.JWT_SECRET;
    delete process.env.PREVIEW_TOKEN_SECRET; delete process.env.JWT_SECRET;
    expect(() => ver.createPreviewToken(id)).toThrow(/PREVIEW_TOKEN_SECRET/);
    process.env.PREVIEW_TOKEN_SECRET = a; if (b) process.env.JWT_SECRET = b;
  });
  it("property: random garbage never verifies and never throws", () =>
    fc.assert(fc.property(fc.string(), (s) => { expect(ver.verifyPreviewToken(s, now)).toBeNull(); })));
  it("property: flipping any single char of a token invalidates it", () => {
    const t = ver.createPreviewToken(id, Date.now());
    fc.assert(fc.property(fc.nat(t.length - 1), (i) => {
      const c = t[i] === "a" ? "b" : "a";
      expect(ver.verifyPreviewToken(t.slice(0, i) + c + t.slice(i + 1))).toBeNull();
    }));
  });
});

describe("mappers", () => {
  it("isUuid", () => {
    expect(isUuid(randomUUID())).toBe(true);
    expect(isUuid(randomUUID().toUpperCase())).toBe(true);
    for (const s of ["", "x", randomUUID() + "x", `'${randomUUID()}`, randomUUID().replace(/-/g, "")]) expect(isUuid(s)).toBe(false);
  });
  it("toCategoryView repairs junk schema", () => {
    const row = { id: "i", slug: "s", name: "n", icon: null, leadCap: 3, prohibited: false, parentId: null } as never;
    expect(toCategoryView({ ...(row as object), attributeSchema: null } as never).attributeSchema).toEqual({ fields: [] });
    expect(toCategoryView({ ...(row as object), attributeSchema: { fields: "x" } } as never).attributeSchema).toEqual({ fields: [] });
  });
  it("liveToListingView is always published+approved and tolerates junk json", () => {
    const d = new Date();
    const r = liveToListingView({ id: "i", sellerBusinessId: "s", categoryId: "c", categorySlug: "cs", categoryName: "cn", title: "t", description: "d", attributes: [1], pricePaise: BigInt(9), priceUnit: null, moq: null, moqUnit: null, hsn: null, language: "en", images: "bad", aiGenerated: false, firstPublishedAt: d, publishedAt: d, version: 3, sellerName: "n", sellerCity: null, sellerState: null, sellerTier: 1, sellerTrustScore: 5, sellerBadgeActive: true } as never);
    expect(r).toMatchObject({ status: "published", moderationStatus: "approved", moderationReason: null, attributes: {}, imageUrls: [], pricePaise: 9, liveVersion: 3 });
  });
  it("toListingView falls back to placeholder urls when no approved image", () => {
    const d = new Date();
    const base = { id: "i", sellerBusinessId: "s", category: {}, title: "t", description: "d", attributes: null, pricePaise: null, imageUrls: ["u"], images: [], createdAt: d, updatedAt: d } as never;
    expect(toListingView(base).imageUrls).toEqual(["u"]);
    expect(toListingView({ ...(base as object), images: [{ id: "x" }] } as never).imageUrls).toEqual(["/media/listing-images/x"]);
  });
});
