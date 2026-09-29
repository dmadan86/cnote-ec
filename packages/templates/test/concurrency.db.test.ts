import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineTemplates } from "../src/registry";
import { renderEmail } from "../src/render";
import { seedDefaultTemplates } from "../src/seed";
import { getTemplate, publishDraft, rollbackTemplate, saveDraft, startDraft } from "../src/store";

const KEY = `test.conc_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
defineTemplates([
  {
    key: KEY, name: "Concurrency", description: "d", category: "transactional", channels: ["email"],
    variables: [{ name: "name", description: "n", example: "A", required: true }],
    defaults: { email: { subject: "v1 {{name}}", body: "<p>v1 {{name}}</p>" } },
  },
]);

let templateId = "";
let v1 = "";

async function cleanup() {
  const ts = await prisma.messageTemplate.findMany({ where: { key: KEY }, select: { id: true } });
  const ids = ts.map((t) => t.id);
  await prisma.messageTemplate.updateMany({ where: { id: { in: ids } }, data: { publishedVersionId: null } });
  await prisma.messageTemplateVersion.deleteMany({ where: { templateId: { in: ids } } });
  await prisma.messageTemplate.deleteMany({ where: { id: { in: ids } } });
  await redis.del(`tpl:ptr:${KEY}:email:en`);
}

/** The invariants every publish/rollback sequence must preserve. */
async function assertInvariants() {
  const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: templateId }, include: { versions: true } });
  const published = t.versions.filter((v) => v.status === "published");
  expect(published.length, "exactly one published version").toBe(1);
  expect(t.publishedVersionId, "pointer matches the published version").toBe(published[0]!.id);
  expect(new Set(t.versions.map((v) => v.version)).size, "version numbers are unique").toBe(t.versions.length);
  expect(t.versions.filter((v) => v.status === "draft").length, "at most one open draft").toBeLessThanOrEqual(1);
  const seen = await renderEmail(KEY, { name: "N" });
  expect(seen.templateVersionId, "renders the pointed-to version (cache in sync)").toBe(t.publishedVersionId);
}

beforeAll(async () => {
  await cleanup();
  await seedDefaultTemplates();
  const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } });
  templateId = t.id;
  v1 = t.publishedVersionId!;
});
afterAll(cleanup);

describe("template versioning under concurrency", () => {
  it("parallel startDraft calls converge on ONE draft (no raw unique-violation errors)", async () => {
    const res = await Promise.allSettled(Array.from({ length: 5 }, () => startDraft(templateId, null)));
    const errors = res.filter((r) => r.status === "rejected");
    expect(errors.map((e) => String((e as PromiseRejectedResult).reason))).toEqual([]);
    const ids = new Set(res.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id));
    expect(ids.size).toBe(1);
    expect(await prisma.messageTemplateVersion.count({ where: { templateId, status: "draft" } })).toBe(1);
  });

  it("two editors saving with the same token: exactly one wins, the other gets a conflict", async () => {
    const detail = await getTemplate(templateId);
    const token = detail!.draftToken;
    const res = await Promise.allSettled([
      saveDraft(templateId, { subject: "A {{name}}", body: "<p>A</p>", token }),
      saveDraft(templateId, { subject: "B {{name}}", body: "<p>B</p>", token }),
    ]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: "conflict" });
  });

  it("publishing the same draft concurrently is safe and idempotent in effect", async () => {
    const draft = (await getTemplate(templateId))!.draft!;
    const res = await Promise.allSettled([publishDraft(draft.id, null), publishDraft(draft.id, null), publishDraft(draft.id, null)]);
    expect(res.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of res) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "conflict" });
    await assertInvariants();
  });

  it("concurrent rollbacks never leave two published versions or duplicate version numbers", async () => {
    const res = await Promise.allSettled([rollbackTemplate(templateId, v1, null), rollbackTemplate(templateId, v1, null), rollbackTemplate(templateId, v1, null)]);
    expect(res.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of res) if (r.status === "rejected") expect(r.reason, String(r.reason)).toMatchObject({ code: expect.any(String) });
    await assertInvariants();
  });

  it("a rollback racing a publish of a fresh draft keeps the single-published invariant", async () => {
    const d = await startDraft(templateId, null);
    await saveDraft(templateId, { subject: "Race {{name}}", body: "<p>race</p>" });
    const res = await Promise.allSettled([publishDraft(d.id, null), rollbackTemplate(templateId, v1, null)]);
    expect(res.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of res) if (r.status === "rejected") expect(r.reason, String(r.reason)).toMatchObject({ code: expect.any(String) });
    await assertInvariants();
  });
});
