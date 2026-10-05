import { afterAll, describe, expect, it } from "vitest";
import { getCategoryBySlug, listCategories } from "@cnote/catalogue";
import { prisma } from "@cnote/db";
import { PACKAGING_BENGALURU, getVerticalBySlug, listChecklist, listOpenVerticals, loadPlaybook } from "../src/index";

const pb = PACKAGING_BENGALURU;

afterAll(async () => {
  await prisma.vertical.deleteMany({ where: { slug: pb.key } });
});

describe("loadPlaybook (explicit activation)", () => {
  it("is off until called: no vertical, no playbook categories", async () => {
    await prisma.vertical.deleteMany({ where: { slug: pb.key } });
    expect(await getVerticalBySlug(pb.key)).toBeNull();
    expect(await listOpenVerticals()).not.toContainEqual(expect.objectContaining({ slug: pb.key }));
  });

  it("rejects an unknown key", async () => {
    await expect(loadPlaybook("nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("upserts the tree and creates a candidate vertical with the ADR-016 checklist; never opens it", async () => {
    const res = await loadPlaybook(pb.key);
    expect(res).toMatchObject({ playbook: pb.key, categories: pb.categories.length, verticalCreated: true });
    expect(res.vertical).toMatchObject({ slug: pb.key, stage: "candidate", languages: ["hi", "en", "kn", "ta", "te"], categorySlugs: ["packaging-materials"] });
    expect((await listChecklist(res.vertical!.id)).length).toBeGreaterThan(10);
    expect(await listOpenVerticals()).not.toContainEqual(expect.objectContaining({ slug: pb.key }));

    const cats = await listCategories();
    for (const c of pb.categories) expect(cats.find((x) => x.slug === c.slug), c.slug).toBeDefined();
    const box = (await getCategoryBySlug("corrugated-boxes"))!;
    expect(box.attributeSchema.fields.map((f) => f.key)).toEqual(expect.arrayContaining(["ply", "length_mm", "liner_gsm", "burst_factor"]));
    expect((await getCategoryBySlug("banned-single-use-plastics"))!.prohibited).toBe(true);
    const parent = cats.find((x) => x.slug === "packaging-materials")!;
    expect(cats.find((x) => x.slug === "corrugated-boxes")!.parentId).toBe(parent.id);
  });

  it("is idempotent and does not touch an existing vertical's stage", async () => {
    const first = await getVerticalBySlug(pb.key);
    await prisma.vertical.update({ where: { id: first!.id }, data: { stage: "paused" } });
    const again = await loadPlaybook(pb.key);
    expect(again.verticalCreated).toBe(false);
    expect(again.vertical!.id).toBe(first!.id);
    expect(again.vertical!.stage).toBe("paused");
  });

  it("can load only the categories", async () => {
    await prisma.vertical.deleteMany({ where: { slug: pb.key } });
    const res = await loadPlaybook(pb.key, { createVertical: false });
    expect(res).toMatchObject({ vertical: null, verticalCreated: false });
    expect(await getVerticalBySlug(pb.key)).toBeNull();
  });
});
