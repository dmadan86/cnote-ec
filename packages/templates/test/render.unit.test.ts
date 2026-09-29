import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, DEFAULT_THEME } from "../src/assemble";
import { defineTemplates } from "../src/registry";
import { previewEmail, previewLayout, previewText, renderEmailContent } from "../src/render";
import type { TemplateDefinition } from "../src/types";

const KEY = "zz.render_unit";
const DEF: TemplateDefinition = {
  key: KEY, name: "Render unit", description: "d", category: "transactional", channels: ["email", "sms"],
  variables: [{ name: "name", description: "", example: "Asha", required: true }, { name: "url", description: "", example: "https://x.example/reset" }],
  defaults: {},
};
defineTemplates([DEF, { ...DEF, key: "zz.render_marketing", category: "marketing", name: "Promo" }]);

const ids = { templateVersionId: null, layoutVersionId: null };
const layout = { headerHtml: "<p>Header {{brand.name}}</p>", footerHtml: "<p>Foot {{whyReceiving}}</p>{{#unsubscribeUrl}}<a href=\"{{unsubscribeUrl}}\">Unsub</a>{{/unsubscribeUrl}}", theme: DEFAULT_THEME };
const content = (o: Partial<{ subject: string | null; preheader: string | null; body: string }> = {}) => ({ subject: "Hello {{name}}", preheader: null, body: "<p>Hi {{name}}</p>", ...o });

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["APP_URL", "BRAND_NAME"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("renderEmailContent", () => {
  it("renders subject as plain text (no HTML escaping) and body as escaped HTML", async () => {
    const r = await renderEmailContent(DEF, content(), layout, { name: `A & <B>` }, ids);
    expect(r.subject).toBe("Hello A & <B>");
    expect(r.html).toContain("Hi A &amp; &lt;B&gt;");
    expect(r.html).not.toContain("<B>");
    expect(r.templateVersionId).toBeNull();
  });
  it("subject whitespace is collapsed; a header-injection attempt cannot add lines", async () => {
    const r = await renderEmailContent(DEF, content({ subject: "Hi {{name}}" }), layout, { name: "A\r\nBcc: evil@x.com\n\nX" }, ids);
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.subject).toBe("Hi A Bcc: evil@x.com X");
  });
  it("subject falls back to the definition name, then 'Notification'", async () => {
    expect((await renderEmailContent(DEF, content({ subject: null }), layout, { name: "A" }, ids)).subject).toBe("Render unit");
    expect((await renderEmailContent(DEF, content({ subject: "   " }), layout, { name: "A" }, ids)).subject).toBe("Render unit");
    expect((await renderEmailContent(undefined, content({ subject: "" }), layout, {}, ids)).subject).toBe("Notification");
  });
  it("preheader is rendered when present, null when empty", async () => {
    expect((await renderEmailContent(DEF, content({ preheader: "Pre {{name}}" }), layout, { name: "A" }, ids)).preheader).toBe("Pre A");
    expect((await renderEmailContent(DEF, content({ preheader: "" }), layout, { name: "A" }, ids)).preheader).toBeNull();
  });
  it("required variables are enforced before any rendering; unknown definitions render permissively", async () => {
    await expect(renderEmailContent(DEF, content(), layout, {}, ids)).rejects.toMatchObject({ code: "validation" });
    expect((await renderEmailContent(undefined, content(), layout, {}, ids)).html).toContain("Hi ");
  });
  it("layout parts get the brand/footer variables; marketing gets an unsubscribe link, transactional never", async () => {
    process.env.BRAND_NAME = "Acme";
    const tx = await renderEmailContent(DEF, content(), layout, { name: "A" }, ids);
    expect(tx.html).toContain("Header Acme");
    expect(tx.html).toContain("service message");
    expect(tx.html).not.toContain("Unsub");
    const mk = await renderEmailContent({ ...DEF, category: "marketing" }, content(), layout, { name: "A", unsubscribeUrl: "https://x.example/u?t=1&y=2" }, ids);
    expect(mk.html).toContain("Unsub");
    expect(mk.html).toContain('href="https://x.example/u?t=1&amp;y=2"');
  });
  it("hostile variable values never produce markup, handlers or dangerous URLs anywhere in the document body", async () => {
    const evil = [`<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>`, `javascript:alert(1)`, `{{{name}}}`, `</td></tr></table><script>1</script>`, `' onmouseover='alert(1)`];
    for (const v of evil) {
      const r = await renderEmailContent(DEF, content({ body: `<p>{{name}}</p><a href="{{url}}">l</a><img src="{{url}}" alt="{{name}}">` }), layout, { name: v, url: v }, ids);
      const body = r.html.slice(r.html.indexOf("<body"));
      expect(body, v).not.toMatch(/<script|<[a-z][^>]*\son[a-z]+\s*=|href="javascript|src="javascript/i);
      expect(r.text, v).toContain("l"); // text/plain part carries the (decoded) value as inert text
    }
  });
  it("a template variable in href/src that resolves to a safe https URL is kept", async () => {
    const r = await renderEmailContent(DEF, content({ body: `<a href="{{url}}">go</a><img src="{{url}}" alt="x">` }), layout, { name: "A", url: "https://cdn.example.com/a.png?x=1&y=2" }, ids);
    expect(r.html).toContain('href="https://cdn.example.com/a.png?x=1&amp;y=2"');
    expect(r.html).toContain('src="https://cdn.example.com/a.png?x=1&amp;y=2"');
  });
  it("text alternative contains body, a separator and the footer, without tags", async () => {
    const r = await renderEmailContent(DEF, content({ body: `<h2>Head</h2><p>Para <a href="https://a.com">link</a></p>` }), layout, { name: "A" }, ids);
    expect(r.text).toContain("Head");
    expect(r.text).toContain("link (https://a.com)");
    expect(r.text).toContain("\n--\n");
    expect(r.text).toContain("Foot");
    expect(r.text).not.toMatch(/<\/?[a-z]/i);
  });
  it("propagates ids and returns absolute asset URLs (APP_URL) for logos", async () => {
    process.env.APP_URL = "https://app.example.in";
    const logoId = "123e4567-e89b-12d3-a456-426614174000";
    const r = await renderEmailContent(DEF, content(), { ...layout, theme: { ...DEFAULT_THEME, logoAssetId: logoId } }, { name: "A" }, { templateVersionId: "tv", layoutVersionId: "lv" });
    expect(r).toMatchObject({ templateVersionId: "tv", layoutVersionId: "lv" });
    expect(r.html).toContain(`src="https://app.example.in/media/template-assets/${logoId}"`);
    expect(r.html).not.toContain('src="/media/template-assets');
  });
  it("unbalanced sections in unsaved content are a validation error", async () => {
    await expect(renderEmailContent(DEF, content({ body: "{{#a}}<p>x</p>" }), layout, { name: "A" }, ids)).rejects.toMatchObject({ code: "validation" });
  });
});

describe("previewEmail (no DB when the layout is supplied inline)", () => {
  it("fills missing variables from the definition's examples; explicit variables win; ids are null", async () => {
    const r = await previewEmail({ key: KEY, subject: "S {{name}}", preheader: null, body: "<p>{{name}}</p>", layout });
    expect(r.subject).toBe("S Asha");
    expect(r.templateVersionId).toBeNull();
    expect(r.layoutVersionId).toBeNull();
    expect((await previewEmail({ key: KEY, subject: "S {{name}}", preheader: null, body: "<p>x</p>", layout, vars: { name: "Zed" } })).subject).toBe("S Zed");
  });
  it("sanitises unsaved content on the way through (script never previews)", async () => {
    const r = await previewEmail({ key: KEY, subject: "s", preheader: null, body: `<p>ok</p><script>alert(1)</script><a href="javascript:1">x</a>`, layout });
    expect(r.html).not.toMatch(/<script|javascript:/);
  });
  it("an unknown key previews without required-variable checks", async () => {
    const r = await previewEmail({ key: "zz.unknown_key", subject: "s", preheader: null, body: "<p>{{a}}</p>", layout });
    expect(r.subject).toBe("s");
  });
  it("rejects an invalid inline theme with a validation error", async () => {
    await expect(previewEmail({ key: KEY, subject: "s", preheader: null, body: "<p>x</p>", layout: { ...layout, theme: { primaryColor: "red" } } })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("previewLayout", () => {
  it("renders a sample body inside the layout for each category", async () => {
    const r = await previewLayout({ headerHtml: DEFAULT_LAYOUT.headerHtml, footerHtml: DEFAULT_LAYOUT.footerHtml, theme: DEFAULT_THEME });
    expect(r.subject).toBe("Layout preview");
    expect(r.preheader).toBe("Preview text");
    expect(r.html).toContain("Sample heading");
    expect(r.html).not.toContain("Unsubscribe");
    const m = await previewLayout({ headerHtml: DEFAULT_LAYOUT.headerHtml, footerHtml: DEFAULT_LAYOUT.footerHtml, theme: DEFAULT_THEME, category: "marketing" });
    expect(m.html).toContain("Unsubscribe");
  });
  it("sanitises the layout HTML being previewed and validates the theme", async () => {
    const r = await previewLayout({ headerHtml: `<script>alert(1)</script><p>H</p>`, footerHtml: `<p onclick="x()">F</p>`, theme: {} });
    expect(r.html).not.toMatch(/<script|onclick/);
    await expect(previewLayout({ headerHtml: "", footerHtml: "", theme: { textColor: "nope" } })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("previewText", () => {
  it("renders title and body from examples, verbatim (no HTML escaping), trimming whitespace", async () => {
    const r = await previewText({ key: KEY, channel: "sms", title: "  T {{name}}  ", body: "  Hi {{name}} & co \n" });
    expect(r).toEqual({ title: "T Asha", body: "Hi Asha & co", templateVersionId: null });
  });
  it("blank titles become null; explicit vars override examples; required variables enforced only when neither supplies them", async () => {
    expect((await previewText({ key: KEY, channel: "sms", title: "   ", body: "b" })).title).toBeNull();
    expect((await previewText({ key: KEY, channel: "sms", title: null, body: "{{name}}", vars: { name: "Z" } })).body).toBe("Z");
    expect((await previewText({ key: "zz.unknown_text", channel: "in_app", title: null, body: "x" })).body).toBe("x");
    await expect(previewText({ key: KEY, channel: "sms", title: null, body: "b", vars: { name: "" } })).rejects.toMatchObject({ code: "validation" });
  });
  it("collapses newlines in titles but keeps them in bodies", async () => {
    const r = await previewText({ key: KEY, channel: "in_app", title: "a\n\nb", body: "l1\nl2" });
    expect(r.title).toBe("a b");
    expect(r.body).toBe("l1\nl2");
  });
});
