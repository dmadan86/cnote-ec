import { prisma } from "@cnote/db";
import { redis } from "@cnote/core";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineTemplates } from "../src/registry";
import { isChannelEnabled, renderEmail, renderText } from "../src/render";
import { seedDefaultTemplates } from "../src/seed";
import { createTemplateLocale, discardDraft, getTemplate, publishDraft, rollbackTemplate, saveDraft, setTemplateEnabled, startDraft } from "../src/store";
import { deleteTemplateAsset, listTemplateAssets, uploadTemplateAsset } from "../src/assets";

const KEY = `test.tpl_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
const NOTIF = `test.notif_${randomUUID().replace(/-/g, "").slice(0, 10)}`;

defineTemplates([
  {
    key: KEY, name: "Test template", description: "d", category: "transactional", channels: ["email"],
    variables: [{ name: "name", description: "n", example: "Asha", required: true }, { name: "link", description: "l", example: "https://x.com" }],
    defaults: { email: { subject: "Hello {{name}}", preheader: "Pre {{name}}", body: "<p>Hi {{name}}, <a href=\"{{link}}\">go</a></p>" } },
  },
  {
    key: NOTIF, name: "Test notif", description: "d", category: "transactional", channels: ["in_app", "sms"],
    variables: [{ name: "who", description: "w", example: "Ravi", required: true }],
    defaults: { in_app: { subject: "Lead from {{who}}", body: "New lead from {{who}}" }, sms: { body: "Lead {{who}}" } },
  },
]);

async function cleanup() {
  const ts = await prisma.messageTemplate.findMany({ where: { key: { in: [KEY, NOTIF] } }, select: { id: true } });
  const ids = ts.map((t) => t.id);
  await prisma.messageTemplate.updateMany({ where: { id: { in: ids } }, data: { publishedVersionId: null } });
  await prisma.messageTemplateVersion.deleteMany({ where: { templateId: { in: ids } } });
  await prisma.messageTemplate.deleteMany({ where: { id: { in: ids } } });
  for (const loc of ["en", "hi", "fr"]) for (const ch of ["email", "in_app", "sms"]) await redis.del(`tpl:ptr:${KEY}:${ch}:${loc}`, `tpl:ptr:${NOTIF}:${ch}:${loc}`);
}

beforeAll(async () => {
  await cleanup();
  await seedDefaultTemplates();
});
afterAll(async () => {
  await cleanup();
});

describe("seed + render", () => {
  it("seed is idempotent and creates published v1 for registered definitions", async () => {
    const again = await seedDefaultTemplates();
    expect(again.templates).toBe(0);
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } });
    expect(t.publishedVersionId).not.toBeNull();
    const layout = await prisma.messageLayout.findUniqueOrThrow({ where: { key: "default" } });
    expect(layout.publishedVersionId).not.toBeNull();
  });

  it("renders escaped variables into the full layout with inlined CSS and text alternative", async () => {
    const r = await renderEmail(KEY, { name: `<b>Asha</b>`, link: "https://example.com/a?x=1&y=2" });
    expect(r.subject).toBe("Hello <b>Asha</b>"); // subject is plain text, not HTML
    expect(r.preheader).toBe("Pre <b>Asha</b>");
    expect(r.html).toContain("&lt;b&gt;Asha&lt;/b&gt;");
    expect(r.html).not.toContain("<b>Asha</b>");
    expect(r.html).toContain('href="https://example.com/a?x=1&amp;y=2"');
    expect(r.html).toMatch(/<td[^>]*class="content"[^>]*style="[^"]*padding/);
    expect(r.html).not.toContain("<style>p{"); // inlined
    expect(r.html).toContain("@media"); // responsive rules preserved
    expect(r.html).toContain("Why am I receiving this?");
    expect(r.html).not.toContain("Unsubscribe"); // transactional
    expect(r.text).toContain("Hi <b>Asha</b>");
    expect(r.text).toContain("go (https://example.com/a?x=1&y=2)");
    expect(r.templateVersionId).not.toBeNull();
    expect(r.layoutVersionId).not.toBeNull();
  });

  it("does not let a variable value inject markup or mustache", async () => {
    const r = await renderEmail(KEY, { name: "{{{link}}}", link: "<script>x</script>" });
    expect(r.html).not.toContain("<script>");
  });

  it("neutralises javascript: urls coming from variables", async () => {
    const r = await renderEmail(KEY, { name: "A", link: "javascript:alert(1)" });
    expect(r.html).not.toContain("javascript:");
  });

  it("validates required variables", async () => {
    await expect(renderEmail(KEY, { link: "x" })).rejects.toMatchObject({ code: "validation" });
    await expect(renderEmail(KEY, { name: "" })).rejects.toMatchObject({ code: "validation" });
  });

  it("renders text channels", async () => {
    const r = await renderText(NOTIF, "in_app", { who: "A & B" });
    expect(r).toMatchObject({ title: "Lead from A & B", body: "New lead from A & B" });
    expect((await renderText(NOTIF, "sms", { who: "R" })).body).toBe("Lead R");
    await expect(renderText(NOTIF, "whatsapp", { who: "R" })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("fallback chain locale → en → code default", () => {
  it("uses the locale row, then en, then code default", async () => {
    const en = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } });
    const hi = await createTemplateLocale(KEY, "email", "hi", null);
    // hi has no published version yet → falls back to en
    expect((await renderEmail(KEY, { name: "A" }, { locale: "hi" })).templateVersionId).toBe(en.publishedVersionId);
    const draft = await startDraft(hi.id, null);
    await saveDraft(hi.id, { subject: "Namaste {{name}}", body: "<p>Namaste {{name}}</p>" });
    await publishDraft(draft.id, null);
    const r = await renderEmail(KEY, { name: "A" }, { locale: "hi" });
    expect(r.subject).toBe("Namaste A");
    // unknown locale → en
    expect((await renderEmail(KEY, { name: "A" }, { locale: "fr" })).subject).toBe("Hello A");
  });

  it("falls back to code defaults when no row exists (and channel is enabled)", async () => {
    await prisma.messageTemplate.updateMany({ where: { key: NOTIF, channel: "sms" }, data: { publishedVersionId: null } });
    await prisma.messageTemplateVersion.deleteMany({ where: { template: { key: NOTIF, channel: "sms" } } });
    await prisma.messageTemplate.deleteMany({ where: { key: NOTIF, channel: "sms" } });
    await redis.del(`tpl:ptr:${NOTIF}:sms:en`);
    expect((await renderText(NOTIF, "sms", { who: "Z" })).body).toBe("Lead Z");
    expect((await renderText(NOTIF, "sms", { who: "Z" })).templateVersionId).toBeNull();
    expect(await isChannelEnabled(NOTIF, "sms")).toBe(true);
    expect(await isChannelEnabled(NOTIF, "whatsapp")).toBe(false);
  });

  it("disabled templates report the channel as off", async () => {
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: NOTIF, channel: "in_app", locale: "en" } } });
    expect(await isChannelEnabled(NOTIF, "in_app")).toBe(true);
    await setTemplateEnabled(t.id, false);
    expect(await isChannelEnabled(NOTIF, "in_app")).toBe(false);
    await setTemplateEnabled(t.id, true);
    expect(await isChannelEnabled(NOTIF, "in_app")).toBe(true);
  });
});

describe("versions: draft → publish → rollback", () => {
  it("keeps one published version, archives the previous, and rollback appends a new version", async () => {
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } });
    const v1 = t.publishedVersionId!;

    const d = await startDraft(t.id, null);
    expect(d.status).toBe("draft");
    expect(d.version).toBe(2);
    expect((await startDraft(t.id, null)).id).toBe(d.id); // one open draft

    const saved = await saveDraft(t.id, { subject: "V2 {{name}}", body: "<p>Second {{name}}</p><script>x</script>" });
    expect(saved.draft.body).toBe("<p>Second {{name}}</p>");

    // conflict protection
    const detail = await getTemplate(t.id);
    const stale = detail!.draftToken!;
    await saveDraft(t.id, { subject: "V2b {{name}}", body: "<p>Second b</p>", token: stale });
    await expect(saveDraft(t.id, { subject: "X", body: "<p>x</p>", token: stale })).rejects.toMatchObject({ code: "conflict" });

    const pub = await publishDraft(d.id, "11111111-1111-4111-8111-111111111111");
    expect(pub.status).toBe("published");
    let cur = await getTemplate(t.id);
    expect(cur!.template.publishedVersionId).toBe(d.id);
    expect(cur!.versions.find((v) => v.id === v1)!.status).toBe("archived");
    expect(cur!.versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect((await renderEmail(KEY, { name: "A" })).subject).toBe("V2b A"); // cache busted on publish

    await expect(publishDraft(d.id, null)).rejects.toMatchObject({ code: "conflict" }); // not a draft anymore

    const rb = await rollbackTemplate(t.id, v1, null);
    expect(rb.version).toBe(3);
    expect(rb.status).toBe("published");
    expect(rb.changeNote).toBe("Rollback to v1");
    cur = await getTemplate(t.id);
    expect(cur!.template.publishedVersionId).toBe(rb.id);
    expect(cur!.versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect(cur!.versions.find((v) => v.id === d.id)!.status).toBe("archived");
    expect((await renderEmail(KEY, { name: "A" })).subject).toBe("Hello A");
  });

  it("enforces unique (key, channel, locale) and version numbers", async () => {
    await expect(createTemplateLocale(KEY, "email", "en", null)).rejects.toMatchObject({ code: "conflict" });
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } });
    await expect(prisma.messageTemplateVersion.create({ data: { templateId: t.id, version: 1, body: "x" } })).rejects.toThrow();
  });

  it("rejects saving empty bodies and discards drafts", async () => {
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } });
    await startDraft(t.id, null);
    await expect(saveDraft(t.id, { subject: "s", body: "<script>x</script>" })).rejects.toMatchObject({ code: "validation" });
    await discardDraft(t.id);
    expect((await getTemplate(t.id))!.draft).toBeNull();
  });
});

describe("template assets", () => {
  // 1x1 PNG
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "base64"));
  it("uploads, lists and deletes unused assets; refuses in-use ones; rejects bad files", async () => {
    await expect(uploadTemplateAsset(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({ code: "validation" });
    await expect(uploadTemplateAsset(new Uint8Array(3 * 1024 * 1024))).rejects.toMatchObject({ code: "validation" });
    const a = await uploadTemplateAsset(png, { altText: "dot" });
    expect(a.url).toBe(`/media/template-assets/${a.id}`);
    expect((await listTemplateAssets()).some((x) => x.id === a.id)).toBe(true);

    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } });
    await startDraft(t.id, null);
    await saveDraft(t.id, { subject: "s", body: `<p><img src="${a.url}" alt="dot"></p>` });
    await expect(deleteTemplateAsset(a.id)).rejects.toMatchObject({ code: "conflict" });
    const r = await (await import("../src/render")).previewEmail({ key: KEY, subject: "s", preheader: null, body: `<p><img src="${a.url}" alt="dot"></p>` });
    expect(r.html).toContain("data:image/png;base64,");
    await discardDraft(t.id);
    await prisma.messageTemplateVersion.deleteMany({ where: { templateId: t.id, status: "archived", body: { contains: a.id } } });
    await deleteTemplateAsset(a.id);
    expect((await listTemplateAssets()).some((x) => x.id === a.id)).toBe(false);
  });
});
