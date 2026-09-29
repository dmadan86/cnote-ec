import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, DEFAULT_THEME, FONT_FAMILIES, appUrl, assembleEmailHtml, buildView, checkRequired, parseTheme, renderMustache } from "../src/assemble";
import { defineTemplates, exampleVars, getTemplateDefinition, listTemplateDefinitions } from "../src/registry";
import type { TemplateDefinition } from "../src/types";

const opts = { seed: 41, numRuns: 300 };
const saved = { ...process.env };
afterEach(() => {
  for (const k of ["APP_URL", "BRAND_NAME", "BRAND_ADDRESS", "SUPPORT_EMAIL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("parseTheme", () => {
  it("defaults everything for empty/garbage input", () => {
    for (const raw of [undefined, null, {}, "str", 5, [], true]) expect(parseTheme(raw)).toEqual(DEFAULT_THEME);
  });
  it("accepts valid values, lower-cases colours, drops unknown keys", () => {
    const t = parseTheme({ primaryColor: "#AABBCC", accentColor: "#123456", backgroundColor: "#ffffff", textColor: "#000000", fontFamily: FONT_FAMILIES.Georgia, logoAssetId: "123E4567-E89B-12D3-A456-426614174000", evil: "<script>" });
    expect(t).toEqual({ primaryColor: "#aabbcc", accentColor: "#123456", backgroundColor: "#ffffff", textColor: "#000000", fontFamily: FONT_FAMILIES.Georgia, logoAssetId: "123e4567-e89b-12d3-a456-426614174000" });
    expect(Object.keys(t).sort()).toEqual(["accentColor", "backgroundColor", "fontFamily", "logoAssetId", "primaryColor", "textColor"]);
  });
  it.each(["red", "#fff", "#12345", "#1234567", "#gggggg", "rgb(1,2,3)", "#ffffff;background:url(x)", "#ffffff\n", " #ffffff", "url(x)", "expression(1)", 123, {}, [], true])("rejects colour %j", (bad) => {
    expect(() => parseTheme({ primaryColor: bad })).toThrowError(expect.objectContaining({ code: "validation" }));
  });
  it("null/undefined/empty colours fall back to the default rather than failing", () => {
    for (const v of [undefined, null, ""]) expect(parseTheme({ accentColor: v }).accentColor).toBe(DEFAULT_THEME.accentColor);
  });
  it("fonts must come from the list (no CSS injection through font-family)", () => {
    for (const bad of ["Comic Sans", "Arial;background:url(x)", "'x'}</style><script>", "arial, helvetica, sans-serif"]) expect(() => parseTheme({ fontFamily: bad })).toThrow("Choose a font");
    for (const ok of Object.values(FONT_FAMILIES)) expect(parseTheme({ fontFamily: ok }).fontFamily).toBe(ok);
    expect(parseTheme({ fontFamily: "" }).fontFamily).toBe(DEFAULT_THEME.fontFamily);
  });
  it("logo asset must be a UUID", () => {
    for (const bad of ["x", "../etc/passwd", "123e4567-e89b-12d3-a456-42661417400", "123e4567-e89b-12d3-a456-426614174000/x", "123e4567-e89b-12d3-a456-426614174000\"onerror="]) expect(() => parseTheme({ logoAssetId: bad })).toThrow("Invalid logo asset");
    expect(parseTheme({ logoAssetId: "" }).logoAssetId).toBeNull();
    expect(parseTheme({ logoAssetId: 5 }).logoAssetId).toBeNull();
  });
  it("PROPERTY: for any input the result is either a DomainError or a fully valid theme (hex colours, listed font, uuid-or-null logo)", () => {
    const anyVal = fc.oneof(fc.string(), fc.constant(undefined), fc.constant(null), fc.integer(), fc.constantFrom("#abcdef", "#ABCDEF", "#12345g", ...Object.values(FONT_FAMILIES)));
    fc.assert(
      fc.property(fc.record({ primaryColor: anyVal, accentColor: anyVal, backgroundColor: anyVal, textColor: anyVal, fontFamily: anyVal, logoAssetId: anyVal }, { requiredKeys: [] }), (raw) => {
        try {
          const t = parseTheme(raw);
          for (const k of ["primaryColor", "accentColor", "backgroundColor", "textColor"] as const) expect(t[k]).toMatch(/^#[0-9a-f]{6}$/);
          expect(Object.values(FONT_FAMILIES)).toContain(t.fontFamily);
          expect(t.logoAssetId === null || /^[0-9a-f-]{36}$/.test(t.logoAssetId)).toBe(true);
          expect(parseTheme(t)).toEqual(t); // idempotent
        } catch (e) {
          expect(e).toMatchObject({ code: "validation" });
        }
      }),
      { ...opts, numRuns: 1000 },
    );
  });
});

describe("checkRequired", () => {
  const def = { key: "a.b", name: "n", description: "", category: "transactional", channels: ["email"], defaults: {}, variables: [{ name: "x", description: "", example: "", required: true }, { name: "y", description: "", example: "", required: true }, { name: "z", description: "", example: "" }] } as TemplateDefinition;
  it("is a no-op for unknown definitions and when all required variables are present", () => {
    expect(() => checkRequired(undefined, {})).not.toThrow();
    expect(() => checkRequired(def, { x: "1", y: 0 })).not.toThrow(); // 0 is a value
    expect(() => checkRequired(def, { x: false, y: "a" })).not.toThrow();
  });
  it("reports every missing required variable (undefined, null, empty string) and never optional ones", () => {
    try {
      checkRequired(def, { x: null, y: "", z: undefined });
      throw new Error("should throw");
    } catch (e) {
      expect(e).toMatchObject({ code: "validation", details: { missing: ["x", "y"] } });
      expect((e as Error).message).toContain("a.b: x, y");
    }
    expect(() => checkRequired(def, { x: "1" })).toThrow(/y/);
  });
});

describe("buildView", () => {
  it("passes caller variables through, adds brand/year/why-receiving, and never lets callers override brand", () => {
    process.env.APP_URL = "https://app.example.in/";
    process.env.BRAND_NAME = "Acme";
    const v = buildView({ name: "A", brand: { name: "Evil" }, year: "1999" }, "transactional", DEFAULT_THEME) as Record<string, any>;
    expect(v.name).toBe("A");
    expect(v.brand.name).toBe("Acme");
    expect(v.brand.appUrl).toBe("https://app.example.in");
    expect(v.year).toBe(String(new Date().getFullYear()));
    expect(v.whyReceiving).toContain("service message");
    expect(v.brand.logoUrl).toBe("");
    expect(v.brand.primaryColor).toBe(DEFAULT_THEME.primaryColor);
  });
  it("brand defaults, logo url from the theme", () => {
    delete process.env.BRAND_NAME;
    delete process.env.BRAND_ADDRESS;
    delete process.env.SUPPORT_EMAIL;
    const v = buildView({}, "transactional", { ...DEFAULT_THEME, logoAssetId: "123e4567-e89b-12d3-a456-426614174000" }) as Record<string, any>;
    expect(v.brand).toMatchObject({ name: "BizKart", supportEmail: "support@bizkart.example", logoUrl: "/media/template-assets/123e4567-e89b-12d3-a456-426614174000" });
    expect(v.brand.address).toContain("registered address");
  });
  it("unsubscribe link only for marketing; caller-supplied link honoured; category text selected", () => {
    process.env.APP_URL = "http://localhost:3000";
    expect((buildView({}, "transactional", DEFAULT_THEME) as any).unsubscribeUrl).toBe("");
    expect((buildView({ unsubscribeUrl: "https://x/u" }, "security", DEFAULT_THEME) as any).unsubscribeUrl).toBe("");
    expect((buildView({}, "marketing", DEFAULT_THEME) as any).unsubscribeUrl).toBe("http://localhost:3000/account/notifications");
    expect((buildView({ unsubscribeUrl: "https://x/u" }, "marketing", DEFAULT_THEME) as any).unsubscribeUrl).toBe("https://x/u");
    expect((buildView({}, "security", DEFAULT_THEME) as any).whyReceiving).toContain("security notice");
    expect((buildView({}, "marketing", DEFAULT_THEME) as any).whyReceiving).toContain("opted in");
    expect((buildView({}, "unknown-cat", DEFAULT_THEME) as any).whyReceiving).toContain("service message");
  });
  it("appUrl strips trailing slashes and defaults to localhost", () => {
    process.env.APP_URL = "https://a.in///";
    expect(appUrl()).toBe("https://a.in");
    delete process.env.APP_URL;
    expect(appUrl()).toBe("http://localhost:3000");
  });
});

describe("assembleEmailHtml", () => {
  const base = { subject: "Hello", preheader: null, bodyHtml: "<p>Body</p>", headerHtml: "<p>H</p>", footerHtml: "<p>F</p>", theme: DEFAULT_THEME };
  it("produces a complete responsive 600px table document with inlined CSS", () => {
    const html = assembleEmailHtml(base);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('lang="en"');
    expect(html).toContain('width="600"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain("@media only screen and (max-width:620px)");
    expect(html).not.toMatch(/<style>[^@]*body\{/); // rules were inlined by juice
    expect(html).toMatch(/<td[^>]*class="content"[^>]*style="[^"]*background-color:\s*#ffffff/);
    const at = (re: RegExp) => html.search(re);
    expect(at(/>H</)).toBeGreaterThan(-1);
    expect(at(/>H</)).toBeLessThan(at(/>Body</));
    expect(at(/>Body</)).toBeLessThan(at(/>F</));
  });
  it("escapes subject and preheader; preheader is hidden and padded", () => {
    const html = assembleEmailHtml({ ...base, subject: `</title><script>alert(1)</script>`, preheader: `<b>"pre"</b>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;&quot;pre&quot;&lt;/b&gt;");
    expect(html).toContain("display:none");
    expect(html).toContain("&zwnj;");
    expect(assembleEmailHtml(base)).not.toContain("preheader");
  });
  it("theme colours and font are injected into the CSS; logo image is escaped and absolute-able", () => {
    process.env.BRAND_NAME = `A"><script>`;
    const html = assembleEmailHtml({ ...base, bodyHtml: '<p>x</p><a href="https://a.com">l</a><blockquote>q</blockquote>', theme: { ...DEFAULT_THEME, primaryColor: "#112233", accentColor: "#445566", backgroundColor: "#778899", textColor: "#aabbcc", logoAssetId: "123e4567-e89b-12d3-a456-426614174000" } });
    for (const c of ["#112233", "#445566", "#778899", "#aabbcc"]) expect(html).toContain(c);
    expect(html).toContain('src="/media/template-assets/123e4567-e89b-12d3-a456-426614174000"');
    expect(html).toContain('alt="A&quot;&gt;&lt;script&gt;"');
    expect(html).not.toContain("<script>");
  });
  it("PROPERTY: arbitrary subject/preheader text can never introduce a tag into the head/preheader", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.string({ maxLength: 80 }), (subject, preheader) => {
        const html = assembleEmailHtml({ ...base, subject, preheader: preheader || null });
        const head = html.slice(0, html.indexOf("</head>"));
        expect(head.match(/<title>([\s\S]*?)<\/title>/)![1]).not.toMatch(/[<>]/);
        const pre = html.match(/<span class="preheader"[^>]*>([\s\S]*?)<\/span>/);
        if (pre) expect(pre[1]).not.toMatch(/<[a-z\/]/i);
      }),
      opts,
    );
  });
  it("DEFAULT_LAYOUT is self-consistent: theme valid, uses brand variables, unsubscribe only via section", () => {
    expect(parseTheme(DEFAULT_LAYOUT.theme)).toEqual(DEFAULT_LAYOUT.theme);
    expect(DEFAULT_LAYOUT.headerHtml).toContain("{{brand.name}}");
    expect(DEFAULT_LAYOUT.footerHtml).toContain("{{#unsubscribeUrl}}");
    expect(DEFAULT_LAYOUT.footerHtml).toContain("{{/unsubscribeUrl}}");
  });
});

describe("renderMustache: missing values", () => {
  it("renders nothing for missing values, keeps 0/false in html mode", () => {
    expect(renderMustache("[{{a}}][{{b}}][{{c}}][{{d}}]", { b: 0, c: false, d: "" }, true)).toBe("[][0][false][]");
  });
});

describe("registry", () => {
  const def = (key: string, over: Partial<TemplateDefinition> = {}): TemplateDefinition => ({ key, name: key, description: "", category: "transactional", channels: ["email"], variables: [], defaults: {}, ...over });
  it.each(["a.b", "auth.password_reset", "lead.matched_v2", "a.b.c", "x1.y2"])("accepts key %s", (k) => expect(() => defineTemplates([def(k)])).not.toThrow());
  it.each(["", "nodot", "A.b", "a.B", "a..b", ".a", "a.", "a b.c", "1a.b", "a.1b", "a-b.c", "a.b-c", "a.b\n", "../x.y", "a/b.c"])("rejects key %j", (k) => expect(() => defineTemplates([def(k)])).toThrow(/Invalid template key/));
  it("re-registering replaces; listing is sorted by key; a rejected batch is applied up to the bad entry", () => {
    defineTemplates([def("zz.reg_b", { name: "one" })]);
    defineTemplates([def("zz.reg_b", { name: "two" }), def("zz.reg_a")]);
    expect(getTemplateDefinition("zz.reg_b")!.name).toBe("two");
    const keys = listTemplateDefinitions().map((d) => d.key);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
    expect(keys.indexOf("zz.reg_a")).toBeLessThan(keys.indexOf("zz.reg_b"));
    expect(getTemplateDefinition("zz.missing")).toBeUndefined();
    expect(() => defineTemplates([def("zz.ok_c"), def("bad")])).toThrow();
    expect(getTemplateDefinition("zz.ok_c")).toBeDefined();
  });
  it("exampleVars maps every variable to its example", () => {
    expect(exampleVars(def("zz.ex", { variables: [{ name: "a", description: "", example: "1" }, { name: "b", description: "", example: "" }] }))).toEqual({ a: "1", b: "" });
    expect(exampleVars(def("zz.ex2"))).toEqual({});
  });
});
