import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_THEME } from "../src/assemble";
import { defineTemplates } from "../src/registry";
import { isChannelEnabled, renderEmail, renderText } from "../src/render";
import { seedDefaultTemplates } from "../src/seed";
import {
  createTemplateLocale, discardDraft, discardLayoutDraft, getLayout, getTemplate, getTemplateVersion, layoutDraftToken, listLayouts, listTemplates, publishDraft, publishLayoutDraft,
  rollbackLayout, rollbackTemplate, saveDraft, saveLayoutDraft, setTemplateEnabled, setTemplateLayout, startDraft, startLayoutDraft, templateDraftToken, unknownVariables,
} from "../src/store";

const rid = () => randomUUID().replace(/-/g, "").slice(0, 10);
const KEY = `test.st_${rid()}`;
const LAYOUT_KEY = `test-lay-${rid()}`;
const ACTOR = "11111111-1111-4111-8111-111111111111";

defineTemplates([
  {
    key: KEY, name: "Store test", description: "desc", category: "transactional", channels: ["email", "sms", "in_app"],
    variables: [{ name: "name", description: "", example: "Asha", required: true }, { name: "url", description: "", example: "https://x.example" }],
    defaults: { email: { subject: "Hi {{name}}", preheader: "Pre", body: "<p>Hello {{name}}</p>" }, sms: { body: "SMS {{name}}" } },
  },
]);

const ids: { tplEmail: string; tplSms: string; layout: string } = { tplEmail: "", tplSms: "", layout: "" };

async function cleanup() {
  const ts = await prisma.messageTemplate.findMany({ where: { key: KEY }, select: { id: true } });
  const tids = ts.map((t) => t.id);
  await prisma.messageTemplate.updateMany({ where: { id: { in: tids } }, data: { publishedVersionId: null, layoutId: null } });
  await prisma.messageTemplateVersion.deleteMany({ where: { templateId: { in: tids } } });
  await prisma.messageTemplate.deleteMany({ where: { id: { in: tids } } });
  const ls = await prisma.messageLayout.findMany({ where: { key: LAYOUT_KEY }, select: { id: true } });
  const lids = ls.map((l) => l.id);
  await prisma.messageLayout.updateMany({ where: { id: { in: lids } }, data: { publishedVersionId: null } });
  await prisma.messageLayoutVersion.deleteMany({ where: { layoutId: { in: lids } } });
  await prisma.messageLayout.deleteMany({ where: { id: { in: lids } } });
  for (const loc of ["en", "hi", "en-in"]) for (const ch of ["email", "sms", "in_app"]) await redis.del(`tpl:ptr:${KEY}:${ch}:${loc}`);
  await redis.del(`tpl:layout-ptr:${LAYOUT_KEY}`);
}

beforeAll(async () => {
  await cleanup();
  await seedDefaultTemplates();
  ids.tplEmail = (await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "email", locale: "en" } } })).id;
  ids.tplSms = (await prisma.messageTemplate.findUniqueOrThrow({ where: { key_channel_locale: { key: KEY, channel: "sms", locale: "en" } } })).id;
  ids.layout = (await prisma.messageLayout.create({ data: { key: LAYOUT_KEY, name: "Test layout" } })).id;
});
afterAll(cleanup);

describe("seedDefaultTemplates", () => {
  it("creates published v1 for every default channel, none for channels without defaults, and is idempotent (also in parallel)", async () => {
    expect(await prisma.messageTemplate.findUnique({ where: { key_channel_locale: { key: KEY, channel: "in_app", locale: "en" } } })).toBeNull();
    const t = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: ids.tplEmail }, include: { versions: true } });
    expect(t.versions).toHaveLength(1);
    expect(t.versions[0]).toMatchObject({ version: 1, status: "published", changeNote: "Initial version from code defaults", subject: "Hi {{name}}", preheader: "Pre" });
    const sms = await prisma.messageTemplate.findUniqueOrThrow({ where: { id: ids.tplSms }, include: { versions: true } });
    expect(sms.versions[0]).toMatchObject({ body: "SMS {{name}}", subject: null, preheader: null });
    const runs = await Promise.all([seedDefaultTemplates(), seedDefaultTemplates(), seedDefaultTemplates()]);
    expect(runs.every((r) => r.templates === 0 && r.layouts === 0)).toBe(true);
    expect(await prisma.messageTemplateVersion.count({ where: { templateId: ids.tplEmail } })).toBe(1);
  });
  it("never overwrites staff edits", async () => {
    await startDraft(ids.tplSms, ACTOR);
    const d = await saveDraft(ids.tplSms, { body: "Edited {{name}}" });
    await publishDraft(d.draft.id, ACTOR);
    await seedDefaultTemplates();
    expect((await renderText(KEY, "sms", { name: "Z" })).body).toBe("Edited Z");
  });
  it("concurrent seeding of a brand-new definition creates each row once", async () => {
    const k = `test.seedrace_${rid()}`;
    defineTemplates([{ key: k, name: "Race", description: "", category: "transactional", channels: ["sms"], variables: [], defaults: { sms: { body: "hi" } } }]);
    try {
      await Promise.all([seedDefaultTemplates(), seedDefaultTemplates(), seedDefaultTemplates(), seedDefaultTemplates()]);
      expect(await prisma.messageTemplate.count({ where: { key: k } })).toBe(1);
      const t = await prisma.messageTemplate.findFirstOrThrow({ where: { key: k }, include: { versions: true } });
      expect(t.versions).toHaveLength(1);
      expect(t.publishedVersionId).toBe(t.versions[0]!.id);
    } finally {
      const ts = await prisma.messageTemplate.findMany({ where: { key: k }, select: { id: true } });
      await prisma.messageTemplate.updateMany({ where: { key: k }, data: { publishedVersionId: null } });
      await prisma.messageTemplateVersion.deleteMany({ where: { templateId: { in: ts.map((t) => t.id) } } });
      await prisma.messageTemplate.deleteMany({ where: { key: k } });
      await redis.del(`tpl:ptr:${k}:sms:en`);
    }
  });
});

describe("listTemplates / getTemplate", () => {
  it("groups by key with definition metadata, published version numbers and draft flags", async () => {
    const group = (await listTemplates()).find((g) => g.key === KEY)!;
    expect(group).toMatchObject({ name: "Store test", description: "desc", category: "transactional" });
    expect(group.rows.map((r) => r.channel).sort()).toEqual(["email", "sms"]);
    expect(group.rows.find((r) => r.channel === "email")).toMatchObject({ publishedVersion: 1, hasDraft: false, locale: "en" });
    expect(group.missingChannels).toEqual([]); // in_app has no default content, so it is not "missing"
    await startDraft(ids.tplEmail, null);
    expect((await listTemplates()).find((g) => g.key === KEY)!.rows.find((r) => r.channel === "email")!.hasDraft).toBe(true);
    await discardDraft(ids.tplEmail);
  });
  it("lists rows for keys that have no code definition anymore, and reports missing channels for definitions", async () => {
    const orphan = `test.orphan_${rid()}`;
    const row = await prisma.messageTemplate.create({ data: { key: orphan, channel: "sms", locale: "en", name: "Orphan" } });
    try {
      const g = (await listTemplates()).find((x) => x.key === orphan)!;
      expect(g).toMatchObject({ name: "Orphan", definition: null, category: null, missingChannels: [] });
    } finally {
      await prisma.messageTemplate.delete({ where: { id: row.id } });
    }
  });
  it("getTemplate returns null for unknown ids and exposes draft token only when a draft exists", async () => {
    expect(await getTemplate(randomUUID())).toBeNull();
    const before = await getTemplate(ids.tplEmail);
    expect(before!.draft).toBeNull();
    expect(before!.draftToken).toBeNull();
    expect(before!.published!.version).toBe(1);
    expect(before!.definition!.key).toBe(KEY);
    const d = await startDraft(ids.tplEmail, ACTOR);
    const after = await getTemplate(ids.tplEmail);
    expect(after!.draftToken).toBe(templateDraftToken(d));
    expect(after!.versions.map((v) => v.version)).toEqual([...after!.versions.map((v) => v.version)].sort((a, b) => b - a));
    await discardDraft(ids.tplEmail);
    expect(await getTemplateVersion(randomUUID())).toBeNull();
    expect((await getTemplateVersion(d.id))!.templateId).toBe(ids.tplEmail);
  });
  it("draft tokens are deterministic and sensitive to every editable field", () => {
    const v = { id: "a", subject: "s", preheader: "p", body: "b", changeNote: "c" };
    expect(templateDraftToken(v)).toBe(templateDraftToken({ ...v }));
    for (const k of ["id", "subject", "preheader", "body", "changeNote"] as const) expect(templateDraftToken({ ...v, [k]: "changed" })).not.toBe(templateDraftToken(v));
    expect(templateDraftToken(v)).toMatch(/^[0-9a-f]{24}$/);
    const l = { id: "a", headerHtml: "h", footerHtml: "f", theme: DEFAULT_THEME };
    expect(layoutDraftToken(l)).not.toBe(layoutDraftToken({ ...l, theme: { ...DEFAULT_THEME, primaryColor: "#000000" } }));
  });
});

describe("drafts: validation", () => {
  it("startDraft: unknown template / unknown source version; forks from a chosen version; keeps history numbering", async () => {
    await expect(startDraft(randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    await expect(startDraft(ids.tplEmail, null, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    const v1 = (await getTemplate(ids.tplEmail))!.published!;
    const d = await startDraft(ids.tplEmail, ACTOR, v1.id);
    expect(d).toMatchObject({ status: "draft", body: v1.body, subject: v1.subject, changeNote: `Based on v${v1.version}`, createdBy: ACTOR });
    expect(d.version).toBeGreaterThan(v1.version);
    await discardDraft(ids.tplEmail);
  });
  it("saveDraft: not found / no open draft", async () => {
    await expect(saveDraft(randomUUID(), { subject: "s", body: "<p>x</p>" })).rejects.toMatchObject({ code: "not_found" });
    await expect(saveDraft(ids.tplEmail, { subject: "s", body: "<p>x</p>" })).rejects.toMatchObject({ code: "conflict" });
  });
  it("email rules: subject required and ≤300, preheader ≤300, body non-empty after sanitising and ≤200k, syntax valid", async () => {
    await startDraft(ids.tplEmail, null);
    const bad = async (input: Parameters<typeof saveDraft>[1], msg: RegExp) => await expect(saveDraft(ids.tplEmail, input)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(msg) });
    await bad({ subject: "", body: "<p>x</p>" }, /needs a subject/);
    await bad({ subject: null, body: "<p>x</p>" }, /needs a subject/);
    await bad({ subject: "x".repeat(301), body: "<p>x</p>" }, /Subject is too long/);
    await bad({ subject: "ok", preheader: "x".repeat(301), body: "<p>x</p>" }, /Preheader is too long/);
    await bad({ subject: "ok", body: "" }, /can't be empty/);
    await bad({ subject: "ok", body: "   " }, /can't be empty/);
    await bad({ subject: "ok", body: "<script>alert(1)</script>" }, /can't be empty/);
    await bad({ subject: "ok", body: "<p>" + "x".repeat(200_001) + "</p>" }, /too large/);
    await bad({ subject: "ok", body: "<p>{{#a}}</p>" }, /syntax error/);
    await bad({ subject: "{{#a}}", body: "<p>x</p>" }, /syntax error/);
    const ok = await saveDraft(ids.tplEmail, { subject: "x".repeat(300), preheader: "y".repeat(300), body: "<p>x</p>", changeNote: "  " + "n".repeat(500) });
    expect(ok.draft.subject).toHaveLength(300);
    expect(ok.draft.changeNote).toHaveLength(300);
    await discardDraft(ids.tplEmail);
  });
  it("saved content is sanitised and mustache-neutralised; warnings list unknown variables (only)", async () => {
    await startDraft(ids.tplEmail, null);
    const r = await saveDraft(ids.tplEmail, {
      subject: "<b>Hi</b> {{{name}}} {{mystery}}", preheader: "{{other}}",
      body: `<p onclick="x()">{{name}} {{url}} {{brand.name}} {{whyReceiving}} {{unsubscribeUrl}} {{year}} {{unknownOne}}</p><script>1</script>{{{name}}}`,
    });
    expect(r.draft.subject).toBe("Hi {{name}} {{mystery}}");
    expect(r.draft.body).not.toMatch(/onclick|script|\{\{\{/);
    expect(r.warnings.sort()).toEqual(["mystery", "other", "unknownOne"]);
    expect(r.token).toBe(templateDraftToken(r.draft));
    await discardDraft(ids.tplEmail);
  });
  it("text channels: no HTML, no preheader, subject optional", async () => {
    await startDraft(ids.tplSms, null);
    const r = await saveDraft(ids.tplSms, { subject: null, preheader: "ignored", body: "<b>Hello</b> {{name}}\r\nBye" });
    expect(r.draft).toMatchObject({ subject: null, preheader: null, body: "Hello {{name}}\nBye" });
    await expect(saveDraft(ids.tplSms, { body: "<i></i>" })).rejects.toMatchObject({ code: "validation" });
    await discardDraft(ids.tplSms);
  });
  it("unknownVariables is empty without a definition and understands sections and dotted names", () => {
    expect(unknownVariables(null, "{{x}}")).toEqual([]);
    expect(unknownVariables(undefined, "{{x}}")).toEqual([]);
    const def = { key: "a.b", name: "", description: "", category: "transactional", channels: ["email"], defaults: {}, variables: [{ name: "known", description: "", example: "" }] } as never;
    expect(unknownVariables(def, "{{known.deep}} {{#list}}{{item}}{{/list}} {{brand.name}}", null, undefined, "{{known}}").sort()).toEqual(["item", "list"]);
  });
  it("discardDraft is idempotent and archives (never deletes) the draft", async () => {
    const d = await startDraft(ids.tplEmail, null);
    await discardDraft(ids.tplEmail);
    await discardDraft(ids.tplEmail);
    expect((await getTemplateVersion(d.id))).toMatchObject({ status: "archived", changeNote: "Discarded draft" });
    expect((await getTemplate(ids.tplEmail))!.draft).toBeNull();
  });
});

describe("publish / rollback edge cases", () => {
  it("publishDraft: unknown version; a non-draft; content that no longer satisfies the sanitiser is refused", async () => {
    await expect(publishDraft(randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    const v1 = (await getTemplate(ids.tplEmail))!.published!;
    await expect(publishDraft(v1.id, null)).rejects.toMatchObject({ code: "conflict" });
    // a draft whose stored body is empty (e.g. created by startDraft on a template without published content) cannot be published
    const t = await prisma.messageTemplate.create({ data: { key: `test.nopub_${rid()}`, channel: "sms", locale: "en", name: "n" } });
    try {
      const d = await startDraft(t.id, null);
      expect(d.body).toBe("");
      await expect(publishDraft(d.id, null)).rejects.toMatchObject({ code: "validation" });
      await prisma.messageTemplateVersion.deleteMany({ where: { templateId: t.id } });
    } finally {
      await prisma.messageTemplate.delete({ where: { id: t.id } });
    }
  });
  it("publishing records who/when and archives exactly the previous version", async () => {
    const before = (await getTemplate(ids.tplEmail))!;
    const d = await startDraft(ids.tplEmail, ACTOR);
    await saveDraft(ids.tplEmail, { subject: "Pub {{name}}", body: "<p>pub {{name}}</p>" });
    const pub = await publishDraft(d.id, ACTOR);
    expect(pub).toMatchObject({ status: "published", publishedBy: ACTOR });
    expect(pub.publishedAt).not.toBeNull();
    const after = (await getTemplate(ids.tplEmail))!;
    expect(after.versions.find((v) => v.id === before.published!.id)!.status).toBe("archived");
    expect((await renderEmail(KEY, { name: "A" })).subject).toBe("Pub A");
  });
  it("rollback: unknown template/version, wrong template, and drafts are rejected; archived and discarded-draft history is restorable", async () => {
    await expect(rollbackTemplate(randomUUID(), randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    await expect(rollbackTemplate(ids.tplEmail, randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    const smsVersion = (await getTemplate(ids.tplSms))!.published!;
    await expect(rollbackTemplate(ids.tplEmail, smsVersion.id, null)).rejects.toMatchObject({ code: "not_found" }); // version of another template
    const draft = await startDraft(ids.tplEmail, null);
    await expect(rollbackTemplate(ids.tplEmail, draft.id, null)).rejects.toMatchObject({ code: "validation" });
    await discardDraft(ids.tplEmail);
    const all = (await getTemplate(ids.tplEmail))!.versions;
    const v1 = all.find((v) => v.version === 1)!;
    const rb = await rollbackTemplate(ids.tplEmail, v1.id, ACTOR);
    expect(rb).toMatchObject({ body: v1.body, subject: v1.subject, status: "published", publishedBy: ACTOR });
    expect(rb.version).toBe(Math.max(...all.map((v) => v.version)) + 1);
    const after = (await getTemplate(ids.tplEmail))!;
    expect(after.versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect(after.versions.find((v) => v.id === v1.id)!.body).toBe(v1.body); // history untouched
  });
  it("history is append-only: version numbers only ever increase and old bodies are never rewritten", async () => {
    const before = (await getTemplate(ids.tplEmail))!.versions;
    const d = await startDraft(ids.tplEmail, null);
    await saveDraft(ids.tplEmail, { subject: "s", body: "<p>new</p>" });
    await publishDraft(d.id, null);
    const after = (await getTemplate(ids.tplEmail))!.versions;
    for (const b of before) expect(after.find((a) => a.id === b.id)).toMatchObject({ version: b.version, body: b.body, subject: b.subject });
    expect(Math.max(...after.map((v) => v.version))).toBeGreaterThan(Math.max(...before.map((v) => v.version)));
  });
});

describe("enable / layout / locale", () => {
  it("setTemplateEnabled / setTemplateLayout: unknown ids, unknown layout", async () => {
    await expect(setTemplateEnabled(randomUUID(), true)).rejects.toMatchObject({ code: "not_found" });
    await expect(setTemplateLayout(randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    await expect(setTemplateLayout(ids.tplEmail, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });
  it("disabling turns the channel off and busts the pointer cache immediately", async () => {
    expect(await isChannelEnabled(KEY, "email")).toBe(true);
    await setTemplateEnabled(ids.tplEmail, false);
    expect(await isChannelEnabled(KEY, "email")).toBe(false);
    await setTemplateEnabled(ids.tplEmail, true);
    expect(await isChannelEnabled(KEY, "email")).toBe(true);
  });
  it("createTemplateLocale: validates locale, key and channel; seeds from English published content; layout inherited; conflicts", async () => {
    for (const bad of ["", "e", "english", "en_IN", "EN-in-x-y", "en-", "1n", "hi/../x"]) await expect(createTemplateLocale(KEY, "email", bad, null), bad).rejects.toMatchObject({ code: "validation" });
    await expect(createTemplateLocale("zz.no_such_key", "email", "hi", null)).rejects.toMatchObject({ code: "not_found" });
    await expect(createTemplateLocale(KEY, "whatsapp", "hi", null)).rejects.toMatchObject({ code: "validation" });
    await expect(createTemplateLocale(KEY, "in_app", "hi", null)).rejects.toMatchObject({ code: "validation", message: expect.stringMatching(/No content/) });
    const row = await createTemplateLocale(KEY, "email", " HI ", ACTOR);
    expect(row).toMatchObject({ locale: "hi", channel: "email", enabled: true, publishedVersionId: null });
    const detail = (await getTemplate(row.id))!;
    expect(detail.draft).toMatchObject({ version: 1, status: "draft", changeNote: "Created from English", createdBy: ACTOR });
    expect(detail.draft!.body).toBe((await getTemplate(ids.tplEmail))!.published!.body);
    await expect(createTemplateLocale(KEY, "email", "hi", null)).rejects.toMatchObject({ code: "conflict" });
    const rc = await createTemplateLocale(KEY, "email", "en-IN", null);
    expect(rc.locale).toBe("en-in");
    // locale fallback for rendering: unpublished locale -> en
    expect((await renderEmail(KEY, { name: "A" }, { locale: "hi" })).subject).toBe((await renderEmail(KEY, { name: "A" })).subject);
    expect((await renderEmail(KEY, { name: "A" }, { locale: " EN-IN " })).templateVersionId).not.toBeNull();
  });
  it("renderEmail(versionId) renders exactly that (even unpublished) version and rejects a mismatching key/channel", async () => {
    const d = await startDraft(ids.tplEmail, null);
    await saveDraft(ids.tplEmail, { subject: "Draft subject {{name}}", body: "<p>draft body</p>" });
    const r = await renderEmail(KEY, { name: "A" }, { versionId: d.id });
    expect(r.subject).toBe("Draft subject A");
    expect(r.templateVersionId).toBe(d.id);
    expect((await renderEmail(KEY, { name: "A" })).subject).not.toBe("Draft subject A"); // live traffic unaffected
    await expect(renderEmail("other.key", { name: "A" }, { versionId: d.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(renderText(KEY, "sms", { name: "A" }, { versionId: d.id })).rejects.toMatchObject({ code: "not_found" });
    await expect(renderEmail(KEY, { name: "A" }, { versionId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    await discardDraft(ids.tplEmail);
  });
  it("renderEmail for an unknown key without defaults is not_found; text/email disabled checks", async () => {
    await expect(renderEmail("zz.nothing_here", {})).rejects.toMatchObject({ code: "not_found" });
    expect(await isChannelEnabled("zz.nothing_here", "email")).toBe(false);
  });
});

describe("layouts", () => {
  it("startLayoutDraft creates the first draft from the code default; one draft at a time; unknown layout", async () => {
    await expect(startLayoutDraft(randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    const d = await startLayoutDraft(ids.layout, ACTOR);
    expect(d).toMatchObject({ version: 1, status: "draft", createdBy: ACTOR, theme: DEFAULT_THEME });
    expect(d.headerHtml).toContain("{{brand.name}}");
    expect((await startLayoutDraft(ids.layout, null)).id).toBe(d.id);
    const detail = (await getLayout(ids.layout))!;
    expect(detail.draftToken).toBe(layoutDraftToken(detail.draft!));
    expect(detail.published).toBeNull();
    expect((await listLayouts()).find((l) => l.id === ids.layout)).toMatchObject({ key: LAYOUT_KEY, publishedVersion: null, hasDraft: true, templateCount: 0 });
  });
  it("saveLayoutDraft sanitises HTML, validates theme, checks syntax, and enforces the edit token", async () => {
    await expect(saveLayoutDraft(randomUUID(), { headerHtml: "", footerHtml: "", theme: {} })).rejects.toMatchObject({ code: "conflict" });
    await expect(saveLayoutDraft(ids.layout, { headerHtml: "<p>h</p>", footerHtml: "<p>f</p>", theme: { primaryColor: "red" } })).rejects.toMatchObject({ code: "validation" });
    await expect(saveLayoutDraft(ids.layout, { headerHtml: "<p>{{#x}}</p>", footerHtml: "<p>f</p>", theme: {} })).rejects.toMatchObject({ code: "validation" });
    const token = (await getLayout(ids.layout))!.draftToken;
    const saved = await saveLayoutDraft(ids.layout, {
      headerHtml: `<script>1</script><p style="color:{{brand.primaryColor}}">{{{brand.name}}}</p>`, footerHtml: `<p onclick="x()">F</p>`, theme: { primaryColor: "#AA0000", evil: 1 }, token,
    });
    expect(saved.draft.headerHtml).toBe(`<p style="color:{{brand.primaryColor}}">{{brand.name}}</p>`);
    expect(saved.draft.footerHtml).toBe("<p>F</p>");
    expect(saved.draft.theme.primaryColor).toBe("#aa0000");
    await expect(saveLayoutDraft(ids.layout, { headerHtml: "<p>x</p>", footerHtml: "<p>y</p>", theme: {}, token })).rejects.toMatchObject({ code: "conflict" }); // stale token
  });
  it("publish -> render through the layout -> rollback -> discard, keeping one published version", async () => {
    const tid = (await getLayout(ids.layout))!.draft!.id;
    await expect(publishLayoutDraft(randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    const pub = await publishLayoutDraft(tid, ACTOR);
    expect(pub).toMatchObject({ status: "published", publishedBy: ACTOR, version: 1 });
    await expect(publishLayoutDraft(tid, null)).rejects.toMatchObject({ code: "conflict" });

    await setTemplateLayout(ids.tplEmail, ids.layout);
    const r = await renderEmail(KEY, { name: "A" });
    expect(r.layoutVersionId).toBe(tid);
    expect(r.html).toContain("#aa0000"); // theme colour reached the document
    expect(r.html).not.toContain("BizKart</strong>"); // our custom header replaced the default one

    const d2 = await startLayoutDraft(ids.layout, null);
    expect(d2.version).toBe(2);
    expect(d2.headerHtml).toBe(pub.headerHtml); // forks from the published version
    await saveLayoutDraft(ids.layout, { headerHtml: "<p>v2 header</p>", footerHtml: "<p>v2 footer</p>", theme: { primaryColor: "#00aa00" } });
    await publishLayoutDraft(d2.id, null);
    const det = (await getLayout(ids.layout))!;
    expect(det.versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect(det.versions.find((v) => v.id === tid)!.status).toBe("archived");
    expect((await renderEmail(KEY, { name: "A" })).html).toContain("v2 header"); // pointer cache busted

    await expect(rollbackLayout(randomUUID(), tid, null)).rejects.toMatchObject({ code: "not_found" });
    await expect(rollbackLayout(ids.layout, randomUUID(), null)).rejects.toMatchObject({ code: "not_found" });
    const draft = await startLayoutDraft(ids.layout, null);
    await expect(rollbackLayout(ids.layout, draft.id, null)).rejects.toMatchObject({ code: "validation" });
    await discardLayoutDraft(ids.layout);
    await discardLayoutDraft(ids.layout);
    const rb = await rollbackLayout(ids.layout, tid, ACTOR);
    expect(rb).toMatchObject({ version: 4, status: "published", headerHtml: pub.headerHtml });
    const final = (await getLayout(ids.layout))!;
    expect(final.versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect(final.layout.publishedVersionId).toBe(rb.id);
    expect((await renderEmail(KEY, { name: "A" })).layoutVersionId).toBe(rb.id);
  });
  it("renderEmail with an explicit layout version: uses it; unknown id is not_found", async () => {
    const some = (await getLayout(ids.layout))!.versions.find((v) => v.status === "archived")!;
    const r = await renderEmail(KEY, { name: "A" }, { layoutVersionId: some.id });
    expect(r.layoutVersionId).toBe(some.id);
    await expect(renderEmail(KEY, { name: "A" }, { layoutVersionId: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
  });
  it("a template whose layout has no published version falls back to the default layout", async () => {
    const empty = await prisma.messageLayout.create({ data: { key: `${LAYOUT_KEY}-empty`, name: "Empty" } });
    try {
      await setTemplateLayout(ids.tplEmail, empty.id);
      const r = await renderEmail(KEY, { name: "A" });
      const def = await prisma.messageLayout.findUniqueOrThrow({ where: { key: "default" } });
      expect(r.layoutVersionId).toBe(def.publishedVersionId);
    } finally {
      await setTemplateLayout(ids.tplEmail, null);
      await prisma.messageLayout.delete({ where: { id: empty.id } });
      await redis.del(`tpl:layout-ptr:${LAYOUT_KEY}-empty`);
    }
  });
  it("layout draft/publish/rollback are safe under concurrency (one published, unique versions)", async () => {
    await setTemplateLayout(ids.tplEmail, null);
    const base = (await getLayout(ids.layout))!;
    const oldest = base.versions[base.versions.length - 1]!.id;
    const drafts = await Promise.allSettled(Array.from({ length: 4 }, () => startLayoutDraft(ids.layout, null)));
    expect(drafts.every((r) => r.status === "fulfilled")).toBe(true);
    expect(new Set(drafts.map((r) => (r as PromiseFulfilledResult<{ id: string }>).value.id)).size).toBe(1);
    const did = (drafts[0] as PromiseFulfilledResult<{ id: string }>).value.id;
    await Promise.allSettled([publishLayoutDraft(did, null), rollbackLayout(ids.layout, oldest, null), rollbackLayout(ids.layout, oldest, null)]);
    const det = (await getLayout(ids.layout))!;
    expect(det.versions.filter((v) => v.status === "published")).toHaveLength(1);
    expect(det.layout.publishedVersionId).toBe(det.versions.find((v) => v.status === "published")!.id);
    expect(new Set(det.versions.map((v) => v.version)).size).toBe(det.versions.length);
  });
});
