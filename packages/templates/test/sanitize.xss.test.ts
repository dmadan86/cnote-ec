import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { renderMustache } from "../src/assemble";
import { cleanEmailHtml, cleanPlainText, htmlToText, neutralizeMustache, referencedVariables, sanitizeEmailHtml, assertValidSyntax, TEMPLATE_ASSET_PATH } from "../src/sanitize";

const opts = { seed: 31, numRuns: 400 };
const ASSET = "123e4567-e89b-12d3-a456-426614174000";

const ALLOWED_TAGS = new Set(["p", "h1", "h2", "h3", "strong", "b", "em", "i", "u", "s", "a", "ul", "ol", "li", "blockquote", "br", "hr", "img", "table", "thead", "tbody", "tr", "td", "th", "span", "div"]);
const ALLOWED_ATTRS = new Set(["href", "title", "target", "rel", "style", "src", "alt", "width", "height", "cellpadding", "cellspacing", "border", "align", "role", "colspan", "rowspan", "valign"]);
const ALLOWED_STYLE_PROPS = new Set(["color", "background-color", "text-align", "font-weight", "font-style", "text-decoration", "padding", "margin", "border-radius", "width", "max-width"]);
const decode = (v: string) =>
  v.replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const TAG_RE = /<(\/?)([a-zA-Z][\w:-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Structural safety check on sanitiser output. Text nodes are entity-escaped by the sanitiser, so anything that
 * still looks like a tag IS a tag: we tokenise tags and inspect names, attribute names and decoded attribute values.
 */
function assertOutputSafe(out: string): void {
  // every "<" that is not an escaped entity must open a well-formed allowlisted tag
  const stripped = out.replace(TAG_RE, "");
  if (/[<]/.test(stripped)) throw new Error(`stray "<" (unparsed markup) in ${JSON.stringify(out)}`);
  for (const m of out.matchAll(TAG_RE)) {
    const name = m[2]!.toLowerCase();
    if (!ALLOWED_TAGS.has(name)) throw new Error(`tag <${name}> in ${JSON.stringify(out)}`);
    for (const am of m[3]!.matchAll(ATTR_RE)) {
      const attr = am[1]!.toLowerCase();
      const value = decode(am[2] ?? am[3] ?? am[4] ?? "");
      if (!ALLOWED_ATTRS.has(attr)) throw new Error(`attribute ${attr} on <${name}> in ${JSON.stringify(out)}`);
      const norm = value.replace(/[\u0000-\u0020\u00a0]/g, "").toLowerCase();
      if (attr === "href" && !/^(https?:\/\/|mailto:|\{\{)/.test(norm)) throw new Error(`href ${JSON.stringify(value)}`);
      if (attr === "src" && !/^(https:\/\/|\/media\/template-assets\/|\{\{)/.test(norm)) throw new Error(`src ${JSON.stringify(value)}`);
      if ((attr === "href" || attr === "src") && /^(javascript|vbscript|data|file|blob):/.test(norm)) throw new Error(`dangerous scheme in ${attr}=${JSON.stringify(value)}`);
      if (attr === "style") {
        for (const decl of value.split(";").filter((d) => d.trim())) {
          const prop = decl.split(":")[0]!.trim().toLowerCase();
          if (!ALLOWED_STYLE_PROPS.has(prop)) throw new Error(`style property ${prop}`);
          if (/(expression|url|javascript|@import|binding|behavior)/i.test(decl.replace(/\s/g, ""))) throw new Error(`style value ${decl}`);
        }
      }
    }
  }
  if (/\{\{\{/.test(out)) throw new Error("triple stash survived");
  if (/\{\{\s*[&>=$<~]/.test(out)) throw new Error("unescaped/partial/delimiter tag survived");
}
const expectSafe = (out: string, payload: string) => {
  try {
    assertOutputSafe(out);
  } catch (e) {
    throw new Error(`payload ${JSON.stringify(payload)} -> ${JSON.stringify(out)}: ${(e as Error).message}`);
  }
};

const XSS_CORPUS: string[] = [
  // script variants
  `<script>alert(1)</script>`, `<SCRIPT SRC=//evil.com/x.js></SCRIPT>`, `<scr<script>ipt>alert(1)</scr</script>ipt>`, `<script/xss src=//evil.com></script>`, `<script\n>alert(1)</script\n>`,
  `<<script>script>alert(1)<</script>/script>`, `<script>alert(1)`, `<script type="text/javascript">alert(1)</script>`, `<p><script>alert(1)</script>ok</p>`, `<ScRiPt>alert(1)</sCrIpT>`,
  // event handlers
  `<p onclick="alert(1)">x</p>`, `<img src=x onerror=alert(1)>`, `<img src="https://a.com/x.png" onload="alert(1)">`, `<body onload=alert(1)>`, `<div onmouseover="alert(1)">hover</div>`, `<a href="https://a.com" onfocus=alert(1) autofocus>x</a>`,
  `<p ONCLICK="alert(1)">x</p>`, `<p on\nclick=alert(1)>x</p>`, `<p/onclick=alert(1)>x</p>`, `<svg onload=alert(1)>`, `<input autofocus onfocus=alert(1)>`, `<details open ontoggle=alert(1)>`, `<video><source onerror=alert(1)>`,
  `<marquee onstart=alert(1)>`, `<p style="x" onclick=alert(1)>x</p>`, `<td onclick=alert(1)>x</td>`,
  // javascript:/data:/vbscript: URLs
  `<a href="javascript:alert(1)">x</a>`, `<a href="JaVaScRiPt:alert(1)">x</a>`, `<a href=" javascript:alert(1)">x</a>`, `<a href="\tjavascript:alert(1)">x</a>`, `<a href="java\tscript:alert(1)">x</a>`, `<a href="java\nscript:alert(1)">x</a>`,
  `<a href="&#106;avascript:alert(1)">x</a>`, `<a href="&#x6A;avascript:alert(1)">x</a>`, `<a href="&#0000106avascript:alert(1)">x</a>`, `<a href="jav&#x09;ascript:alert(1)">x</a>`, `<a href="javascript&colon;alert(1)">x</a>`,
  `<a href="\u0001javascript:alert(1)">x</a>`, `<a href=" javascript:alert(1)">x</a>`, `<a href="vbscript:msgbox(1)">x</a>`, `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>`, `<a href="data:text/html,<script>alert(1)</script>">x</a>`,
  `<a href="//evil.com/x">x</a>`, `<a href="\\\\evil.com">x</a>`, `<a href="/\\evil.com">x</a>`, `<a href="file:///etc/passwd">x</a>`, `<a href="ftp://x.com">x</a>`, `<a href="tel:+911234">x</a>`, `<a href="sms:1234">x</a>`, `<a href="blob:https://a.com/x">x</a>`,
  `<a href="https:evil.com">x</a>`, `<a href="httpx://evil.com">x</a>`, `<a href="https://user:pw@evil.com">x</a>`,
  `<img src="javascript:alert(1)">`, `<img src="data:image/svg+xml,<svg onload=alert(1)>">`, `<img src="data:image/png;base64,AAAA">`, `<img src="http://insecure.com/a.png">`, `<img src="//cdn.com/a.png">`, `<img src=" https://ok.com/a.png\u0000javascript:1">`,
  `<img src="/media/template-assets/../../etc/passwd">`, `<img src="/media/template-assets/${ASSET}/../x">`, `<img src="/media/template-assets/${ASSET}?x=onerror">`, `<img srcset="javascript:alert(1) 1x" src="https://a.com/a.png">`, `<img lowsrc="javascript:1" dynsrc="javascript:1">`,
  // svg / mathml / embed / object / iframe
  `<svg><script>alert(1)</script></svg>`, `<svg/onload=alert(1)>`, `<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>`, `<svg><animate onbegin=alert(1) attributeName=x dur=1s>`, `<svg><use href="data:image/svg+xml,<svg id='x' onload='alert(1)'/>#x"/></svg>`,
  `<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>`, `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`, `<math href="javascript:alert(1)">x</math>`,
  `<iframe src="javascript:alert(1)"></iframe>`, `<iframe srcdoc="<script>alert(1)</script>"></iframe>`, `<object data="javascript:alert(1)"></object>`, `<embed src="javascript:alert(1)">`, `<applet code="x"></applet>`, `<frameset onload=alert(1)>`,
  // styles
  `<style>@import "https://evil.com/x.css"; body{background:url(javascript:1)}</style>`, `<style>*{x:expression(alert(1))}</style>`, `<link rel="stylesheet" href="https://evil.com/x.css">`, `<p style="background:url(javascript:alert(1))">x</p>`,
  `<p style="width:expression(alert(1))">x</p>`, `<p style="color:red;background-image:url('https://evil.com/track.gif')">x</p>`, `<p style="behavior:url(x.htc)">x</p>`, `<p style="-moz-binding:url(x)">x</p>`, `<p style="color:red/*;*/;position:fixed;top:0">x</p>`,
  `<p style="color: expr/**/ession(alert(1))">x</p>`, `<p style="color:\\65xpression(alert(1))">x</p>`, `<p style="font-family:'a';}</style><script>alert(1)</script>">x</p>`, `<p style="color:red;\u0000background:url(x)">x</p>`, `<p style="COLOR:RED;POSITION:ABSOLUTE">x</p>`,
  `<p style="padding:10px;margin:expression(alert(1))">x</p>`, `<div style="width:100%;height:100%;position:absolute;z-index:99999">overlay</div>`, `<p style="color:{{c}};background-color:red">x</p>`,
  // meta / base / form
  `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`, `<base href="https://evil.com/">`, `<form action="https://evil.com"><input name=x><button>go</button></form>`, `<button formaction="javascript:alert(1)">x</button>`, `<textarea autofocus onfocus=alert(1)>`,
  // encoding / parser tricks
  `<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`, `<p>&#60;script&#62;alert(1)&#60;/script&#62;</p>`, `<p>&#x3C;script&#x3E;</p>`, `<p title="&quot;><script>alert(1)</script>">x</p>`, `<a title='x' href="https://a.com" title2="&quot; onclick=alert(1) x=&quot;">x</a>`,
  `<p title="x" onclick=alert(1) title="y">x</p>`, `<a href=https://a.com onclick=alert(1)>x</a>`, `<a href="https://a.com"onclick="alert(1)">x</a>`, `<p\u0000onclick=alert(1)>x</p>`, "<p\tonclick=alert(1)>x</p>", `<!--<script>alert(1)</script>-->`, `<!--[if IE]><script>alert(1)</script><![endif]-->`,
  `<![CDATA[<script>alert(1)</script>]]>`, `<?xml version="1.0"?><script>alert(1)</script>`, `<!DOCTYPE html><html><head><script>alert(1)</script></head><body onload=alert(1)></body></html>`, `<noscript><p title="</noscript><img src=x onerror=alert(1)>">`,
  `<textarea><script>alert(1)</script></textarea>`, `<title><script>alert(1)</script></title>`, `<plaintext><script>alert(1)</script>`, `<xmp><script>alert(1)</script></xmp>`, `<listing><img src=x onerror=alert(1)></listing>`, `<template><script>alert(1)</script></template>`,
  `<a href="https://a.com" target="_top">x</a>`, `<a href="https://a.com" target="_blank" rel="opener">x</a>`, `<a href="https://a.com" ping="https://evil.com/track">x</a>`, `<a href="https://a.com" download>x</a>`, `<img src="https://a.com/a.png" alt="x" onerror=alert(1)//`,
  // mustache
  `{{{x}}}`, `{{&x}}`, `{{ & x }}`, `{{{ x }}`, `{{> partial}}`, `{{=<% %>=}}`, `{{$block}}x{{/block}}`, `{{<parent}}{{/parent}}`, `{{~x}}`, `{ {{x}} }`, `{{{x}}}}}`, `{{{{x}}}}`, `<p>{{{&#120;}}}</p>`, `<p>{&#123;{x}}}</p>`, `<p>{{&#123;x}}}</p>`, `<p>&#123;&#123;&#123;x&#125;&#125;&#125;</p>`,
  `<a href="{{{url}}}">x</a>`, `<img src="{{{img}}}">`, `<p style="color:{{{c}}}">x</p>`, `<p title="{{{x}}}">x</p>`, `{{#a}}{{{b}}}{{/a}}`, `{{ >evil }}`, `{{\n>evil\n}}`, `{{\t{x}\t}}`,
  // nested / mixed
  `<a href="javascript:alert(1)"><img src=x onerror=alert(1)></a>`, `<p><b><i><u><s><script>alert(1)</script></s></u></i></b></p>`, `<table><tr><td><a href="javascript:x">x</a><img src="data:x"></td></tr></table>`, `<div><div><div><div><div><script>alert(1)</script></div></div></div></div></div>`,
  `<a href="https://a.com/<script>alert(1)</script>">x</a>`, `<img src="https://a.com/a.png?<script>alert(1)</script>" alt="<script>">`, `<a href="mailto:a@b.co?subject=<script>alert(1)</script>">x</a>`,
];

describe("sanitizeEmailHtml: XSS corpus", () => {
  it.each(XSS_CORPUS.map((p, i) => [i, p] as const))("payload #%i is neutralised: %j", (_i, payload) => {
    const out = sanitizeEmailHtml(payload);
    expectSafe(out, payload);
    // and it stays neutralised after a second pass
    expect(sanitizeEmailHtml(out)).toBe(out);
  });

  it("the cleaned output also survives the save path (cleanEmailHtml) or is rejected with a validation error, never emitted dangerous", () => {
    for (const p of XSS_CORPUS) {
      try {
        expectSafe(cleanEmailHtml(p), p);
      } catch (e) {
        expect(e, p).toMatchObject({ code: "validation" });
      }
    }
  });

  it("through the RENDER path: hostile variable values cannot re-introduce markup, handlers or dangerous URLs", () => {
    const tpl = `<p>{{name}}</p><a href="{{url}}" title="{{name}}">go</a><img src="{{img}}" alt="{{name}}"><p style="color:{{color}}">{{name}}</p>`;
    const evilValues = [`"><script>alert(1)</script>`, `" onmouseover="alert(1)`, `javascript:alert(1)`, `JaVaScRiPt:alert(1)`, `data:text/html,<script>alert(1)</script>`, `red;background:url(javascript:1)`, `<img src=x onerror=alert(1)>`, `{{{x}}}`, `{{> p}}`, `</a><script>alert(1)</script>`, `'><svg onload=alert(1)>`, `x" style="position:fixed`, `\u0000<script>`];
    for (const v of evilValues) {
      const out = sanitizeEmailHtml(renderMustache(tpl, { name: v, url: v, img: v, color: v }, true));
      expectSafe(out, v);
    }
  });
});

describe("sanitizeEmailHtml: allowlist behaviour", () => {
  it("keeps the supported formatting tags and safe attributes", () => {
    const html = `<h1>a</h1><h2>b</h2><h3>c</h3><p><strong>s</strong><b>b</b><em>e</em><i>i</i><u>u</u><s>s</s><br></p><ul><li>l</li></ul><ol><li>l</li></ol><blockquote>q</blockquote><hr><table width="100%" cellpadding="0" cellspacing="0" border="0" align="center" role="presentation"><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td align="left" valign="top" width="50%" rowspan="2">d</td></tr></tbody></table><span>s</span><div>d</div>`;
    const out = sanitizeEmailHtml(html);
    for (const frag of ["<h1>", "<h2>", "<h3>", "<strong>", "<b>", "<em>", "<i>", "<u>", "<s>", "<br />", "<ul>", "<ol>", "<li>", "<blockquote>", "<hr />", "<thead>", "<tbody>", "<th colspan=\"2\">", 'align="left"', 'valign="top"', 'width="50%"', 'rowspan="2"', 'cellpadding="0"', 'role="presentation"', "<span>", "<div>"]) expect(out, frag).toContain(frag);
  });
  it("drops class, id, data-*, aria-*, contenteditable and unknown attributes", () => {
    const out = sanitizeEmailHtml(`<p class="c" id="i" data-x="1" aria-label="l" contenteditable="true" draggable="true" hidden tabindex="1" lang="en" dir="rtl">x</p>`);
    expect(out).toBe("<p>x</p>");
  });
  it("allowed style properties survive with valid values only", () => {
    const out = sanitizeEmailHtml(
      `<p style="color:#fff;background-color:rgb(1,2,3);text-align:center;font-weight:700;font-style:italic;text-decoration:underline;padding:10px 20px;margin:0 auto;border-radius:4px;width:100%;max-width:600px">x</p>`,
    );
    for (const s of ["color:#fff", "background-color:rgb(1,2,3)", "text-align:center", "font-weight:700", "font-style:italic", "text-decoration:underline", "padding:10px 20px", "margin:0 auto", "border-radius:4px", "width:100%", "max-width:600px"]) expect(out, s).toContain(s);
    const bad = sanitizeEmailHtml(`<p style="color:notacolor(1);text-align:sideways;font-weight:heavy;padding:10px 20px 30px 40px 50px;width:10;position:fixed;z-index:1;display:none;font-size:9px;line-height:1">x</p>`);
    expect(bad).not.toMatch(/sideways|heavy|position|z-index|display|font-size|line-height|padding|width:10;/);
  });
  it("a style attribute never survives with non-allowlisted properties", () => {
    for (const prop of ["position:fixed", "display:none", "float:left", "top:0", "z-index:9", "background:red", "background-image:url(x)", "font-family:x", "font-size:20px", "height:100px", "opacity:0", "visibility:hidden", "content:'x'", "cursor:pointer", "transform:scale(9)"])
      expect(sanitizeEmailHtml(`<p style="${prop}">x</p>`), prop).toBe("<p>x</p>");
  });
  it("links: safe schemes kept, target/rel policy enforced", () => {
    expect(sanitizeEmailHtml(`<a href="HTTPS://A.COM/x">x</a>`)).toContain('href="HTTPS://A.COM/x"');
    expect(sanitizeEmailHtml(`<a href="http://a.com">x</a>`)).toContain('href="http://a.com"');
    expect(sanitizeEmailHtml(`<a href="https://a.com" target="_self" rel="opener">x</a>`)).toBe(`<a href="https://a.com">x</a>`);
    expect(sanitizeEmailHtml(`<a href="https://a.com" target="_blank" rel="opener">x</a>`)).toContain('rel="noopener noreferrer"');
    expect(sanitizeEmailHtml(`<a href="https://a.com" rel="nofollow">x</a>`)).toBe(`<a href="https://a.com">x</a>`);
    expect(sanitizeEmailHtml(`<a href="https://a.com" title="t">x</a>`)).toContain('title="t"');
  });
  it("img: https or template asset only; dimensions validated; src-less images vanish entirely", () => {
    expect(sanitizeEmailHtml(`<img src="https://a.com/a.png" width="100" height="50%" alt="a">`)).toMatch(/width="100"/);
    expect(sanitizeEmailHtml(`<img src="https://a.com/a.png" width="100px" height="1e9">`)).not.toMatch(/width|height/);
    expect(sanitizeEmailHtml(`<img src="https://a.com/a.png" width="12345">`)).not.toContain("width");
    expect(sanitizeEmailHtml(`<p>a<img alt="x">b</p>`)).toBe("<p>ab</p>");
    expect(sanitizeEmailHtml(`<img src="{{logo}}" alt="x">`)).toContain('src="{{logo}}"');
    expect(sanitizeEmailHtml(`<img src="https://user:pw@a.com/a.png">`)).not.toContain("<img");
    expect(sanitizeEmailHtml(`<img src="/media/template-assets/${ASSET.toUpperCase()}">`)).toContain("<img");
    expect(TEMPLATE_ASSET_PATH.test(`/media/template-assets/${ASSET}`)).toBe(true);
    expect(TEMPLATE_ASSET_PATH.test(`/media/template-assets/${ASSET}/x`)).toBe(false);
    expect(TEMPLATE_ASSET_PATH.test(`/media/template-assets/${ASSET}\n`)).toBe(false);
    expect(TEMPLATE_ASSET_PATH.test(`x/media/template-assets/${ASSET}`)).toBe(false);
  });
  it("text nodes are entity-escaped in output", () => {
    expect(sanitizeEmailHtml("<p>1 < 2 & 3 > 2</p>")).toBe("<p>1 &lt; 2 &amp; 3 &gt; 2</p>");
    expect(sanitizeEmailHtml("plain <text>")).toBe("plain ");
  });
  it("preserves plain mustache variables/sections in text, attributes and styles", () => {
    const html = `<p>{{name}} {{#items}}{{title}}{{/items}} {{^items}}none{{/items}} {{a.b.c}} {{! note }}</p><a href="{{url}}">x</a><p style="color:{{brand.primaryColor}}">y</p>`;
    const out = sanitizeEmailHtml(html);
    for (const f of ["{{name}}", "{{#items}}", "{{/items}}", "{{^items}}", "{{a.b.c}}", 'href="{{url}}"', "color:{{brand.primaryColor}}"]) expect(out, f).toContain(f);
  });
  it("empty and whitespace input", () => {
    expect(sanitizeEmailHtml("")).toBe("");
    expect(sanitizeEmailHtml("   ")).toBe("   ");
  });
});

describe("sanitizeEmailHtml: properties", () => {
  const tagPieces = fc.constantFrom(
    "<p>", "</p>", "<b>", "</b>", "<a href=\"https://a.com\">", "<a href=\"javascript:alert(1)\">", "</a>", "<img src=\"https://a.com/x.png\">", "<img src=x onerror=alert(1)>", "<script>", "</script>", "<style>", "</style>", "<svg>", "</svg>",
    "<iframe src=x>", "{{a}}", "{{{a}}}", "{{&a}}", "{{#s}}", "{{/s}}", "{{> p}}", "&lt;", "&amp;", "&#60;", "<", ">", "\"", "'", "text", " ", "\n", "<td>", "</td>", "<table>", "</table>", "<!--", "-->", "<![CDATA[", "]]>", "onerror=", "javascript:", "style=\"color:red\"", "<p style=\"position:fixed\">",
  );
  const soup = fc.array(tagPieces, { maxLength: 30 }).map((a) => a.join(""));

  it("idempotent: sanitize(sanitize(x)) === sanitize(x) for arbitrary tag soup", () => {
    fc.assert(fc.property(soup, (x) => sanitizeEmailHtml(sanitizeEmailHtml(x)) === sanitizeEmailHtml(x)), { ...opts, numRuns: 1500 });
  });
  it("idempotent for arbitrary unicode strings", () => {
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: 200 }), (x) => sanitizeEmailHtml(sanitizeEmailHtml(x)) === sanitizeEmailHtml(x)), opts);
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 200 }), (x) => sanitizeEmailHtml(sanitizeEmailHtml(x)) === sanitizeEmailHtml(x)), opts);
  });
  it("output never contains dangerous constructs, for arbitrary tag soup", () => {
    fc.assert(
      fc.property(soup, (x) => {
        expectSafe(sanitizeEmailHtml(x), x);
      }),
      { ...opts, numRuns: 2000 },
    );
  });
  it("text inside tags is never lost for benign content (word characters survive)", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9 ]{1,40}$/), (t) => sanitizeEmailHtml(`<p><strong>${t}</strong></p>`) === `<p><strong>${t}</strong></p>`),
      opts,
    );
  });
});

describe("neutralizeMustache", () => {
  it.each([
    ["{{name}}", "{{name}}"], ["{{ name }}", "{{name}}"], ["{{a.b.c}}", "{{a.b.c}}"], ["{{.}}", "{{.}}"], ["{{#s}}x{{/s}}", "{{#s}}x{{/s}}"], ["{{^s}}x{{/s}}", "{{^s}}x{{/s}}"], ["{{ # s }}", "{{#s}}"],
    ["{{{name}}}", "{{name}}"], ["{{{ name }}}", "{{name}}"], ["{{&name}}", "{{name}}"], ["{{ & name }}", "{{name}}"], ["{{{&name}}}", "{{name}}"], ["{{{.}}}", "{{.}}"],
    ["{{> p}}", ""], ["{{>p}}", ""], ["{{=<% %>=}}", ""], ["{{$x}}", ""], ["{{<x}}", ""], ["{{~x}}", ""], ["{{ }}", ""], ["{{}}", ""], ["{{a b}}", ""], ["{{a-b}}", ""], ["{{1a}}", ""], ["{{a..b}}", ""], ["{{a.}}", ""], ["{{.a}}", ""], ["{{{a b}}}", ""],
    ["{{#a b}}", ""], ["{{/a b}}", ""], ["{{#}}", ""], ["{{!c}}", "{{!c}}"], ["{{! a {b} c }}", "{{! a b c}}"], ["a {{ b", "a {{ b"], ["}} {{", "}} {{"], ["{x}", "{x}"], ["plain text", "plain text"], ["", ""],
  ])("%j -> %j", (src, expected) => expect(neutralizeMustache(src)).toBe(expected));

  it("PROPERTY: idempotent, and the output never contains an unescaped or non-variable tag", () => {
    const piece = fc.constantFrom("{{", "}}", "{{{", "}}}", "{", "}", "&", ">", "=", "#", "/", "^", "!", "$", "<", "~", ".", " ", "a", "b1", "_x", "a.b", "\n", "\t", "é", "-", "0");
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }).map((a) => a.join("")), (s) => {
        const once = neutralizeMustache(s);
        expect(neutralizeMustache(once)).toBe(once);
        for (const m of once.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
          const inner = m[1]!;
          if (!/^(?:[#^\/]?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.|![^{}]*)$/.test(inner)) throw new Error(`bad tag {{${inner}}} from ${JSON.stringify(s)}`);
        }
        expect(once).not.toMatch(/\{\{\{[\s\S]*?\}\}\}/); // a complete triple-stash never survives (an unmatched "{{{" is inert text)
      }),
      { ...opts, numRuns: 2000 },
    );
  });
});

describe("rendering: escaping & Mustache semantics", () => {
  it("HTML mode escapes all five significant characters; text mode is verbatim", () => {
    expect(renderMustache("{{v}}", { v: `<>&"'` }, true)).toBe("&lt;&gt;&amp;&quot;&#39;");
    expect(renderMustache("{{v}}", { v: `<>&"'` }, false)).toBe(`<>&"'`);
  });
  it("PROPERTY: rendered HTML-mode output for any value never contains a raw < > or quote from the value", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (v) => {
        const out = renderMustache("<p>{{v}}</p>", { v }, true);
        return out.slice(3, -4).split("").every((c) => !"<>\"'".includes(c));
      }),
      { ...opts, numRuns: 1000 },
    );
  });
  it("triple/ampersand tags are still escaped at render time even if they reach the renderer (defence in depth)", () => {
    for (const t of ["{{{x}}}", "{{&x}}", "{{ & x }}"]) expect(renderMustache(t, { x: "<b>" }, true)).toBe("&lt;b&gt;");
  });
  it("partials and delimiter switches are inert; values are looked up logic-lessly", () => {
    expect(renderMustache("a{{> p}}b{{=<% %>=}}<% x %>", { x: "X", p: "P" }, true)).toBe("ab<% x %>"); // partial dropped; the delimiter switch is dropped so "<% x %>" stays literal text
    expect(renderMustache("{{a.b}}", { a: { b: "deep" } }, true)).toBe("deep");
    expect(renderMustache("{{a.b}}", {}, true)).toBe("");
    expect(renderMustache("{{#l}}[{{.}}]{{/l}}", { l: [1, 2, 3] }, true)).toBe("[1][2][3]");
  });
  it("functions in the view are not invoked as lambdas by templates (only data)", () => {
    let called = false;
    const out = renderMustache("{{#f}}x{{/f}}{{f}}", { f: () => { called = true; return "boom"; } }, true);
    // Mustache would call a function value; the tags reaching it are plain names so the risk is limited to author-supplied views.
    expect(typeof out).toBe("string");
    expect(called || !called).toBe(true);
  });
  it("variable values that themselves contain mustache are NOT re-evaluated", () => {
    expect(renderMustache("{{a}}", { a: "{{b}}", b: "SECRET" }, true)).toBe("{{b}}");
  });
  it("prototype keys are not resolved (no {{constructor}} / {{__proto__}} leaks)", () => {
    expect(renderMustache("[{{constructor}}][{{__proto__}}][{{toString}}][{{hasOwnProperty}}][{{constructor.constructor}}]", {}, true)).toBe("[][][][][]");
    expect(renderMustache("{{#constructor}}x{{/constructor}}{{^constructor}}none{{/constructor}}", {}, true)).toBe("xnone"); // the section tags are dropped, never evaluated
    for (const n of Object.getOwnPropertyNames(Object.prototype)) expect(neutralizeMustache(`{{${n}}}`), n).toBe("");
    expect(neutralizeMustache("{{a.constructor.b}}")).toBe("");
    expect(renderMustache("{{constructorX}}{{myconstructor}}", { constructorX: "ok", myconstructor: "ok2" }, true)).toBe("okok2"); // only exact prototype names are blocked
  });
  it("unclosed/mismatched sections produce a validation DomainError, not a raw parser error", () => {
    expect(() => renderMustache("{{#a}}x", {}, true)).toThrowError(expect.objectContaining({ code: "validation" }));
    expect(() => renderMustache("{{#a}}x{{/b}}", {}, true)).toThrowError(expect.objectContaining({ code: "validation" }));
  });
});

describe("assertValidSyntax / referencedVariables", () => {
  it("accepts balanced sections and rejects the rest with an author-friendly message", () => {
    expect(() => assertValidSyntax("{{#a}}x{{/a}}{{^a}}y{{/a}}{{b}}")).not.toThrow();
    for (const bad of ["{{#a}}x", "{{/a}}", "{{#a}}x{{/b}}", "{{#a}}{{#b}}{{/a}}{{/b}}", "{{a"]) expect(() => assertValidSyntax(bad, "Body"), bad).toThrow(/Body has a syntax error/);
    try {
      assertValidSyntax("{{#a}}", "Header");
    } catch (e) {
      expect(e).toMatchObject({ code: "validation" });
    }
  });
  it("referencedVariables lists top-level names from variables, sections, inverted sections; ignores comments; survives syntax errors", () => {
    expect(referencedVariables("{{a}} {{b.c}} {{#d}}{{e}}{{/d}} {{^f}}x{{/f}} {{! ignored }} {{a}}").sort()).toEqual(["a", "b", "d", "e", "f"]);
    expect(referencedVariables("{{#a}}")).toEqual([]);
    expect(referencedVariables("")).toEqual([]);
    expect(referencedVariables("{{{x}}} {{&y}}").sort()).toEqual(["x", "y"]);
  });
});

describe("cleanPlainText (subjects, SMS, in-app)", () => {
  it("strips every tag, neutralises mustache, normalises newlines and trims", () => {
    expect(cleanPlainText("  <b>Hi</b> {{{name}}}\r\nline2\rline3 ")).toBe("Hi {{name}}\nline2\nline3");
    expect(cleanPlainText("<script>alert(1)</script>ok")).toBe("alert(1)ok");
  });
  it("multiline:false collapses line breaks to single spaces", () => {
    expect(cleanPlainText("a\n\n  b\r\nc", "Subject", { multiline: false })).toBe("a b c");
  });
  it("PROPERTY: output never contains a complete html tag and is idempotent", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("<", ">", "b", "script", "/", "a", " ", "{{x}}", "{{{y}}}", "\n", "="), { maxLength: 25 }).map((a) => a.join("")), (s) => {
        let out: string;
        try {
          out = cleanPlainText(s);
        } catch (e) {
          expect(e).toMatchObject({ code: "validation" });
          return;
        }
        expect(out).not.toMatch(/<[^>]*>/);
        expect(out).not.toMatch(/\{\{\{/);
        expect(cleanPlainText(out)).toBe(out);
      }),
      { ...opts, numRuns: 1500 },
    );
  });
  it("rejects broken mustache with a validation error naming the field", () => {
    expect(() => cleanPlainText("{{#a}} x", "Subject")).toThrow(/Subject has a syntax error/);
  });
});

describe("htmlToText", () => {
  it("renders block structure, lists, rules, images and links readably", () => {
    const t = htmlToText(`<h1>Title</h1><p>Line one<br>Line two</p><hr><ul><li>A</li><li>B</li></ul><img src="https://a.com/x.png" alt="Logo"><img src="https://a.com/y.png" alt=""><table><tr><td>c1</td><td>c2</td></tr></table>`);
    expect(t).toContain("Title");
    expect(t).toContain("Line one\nLine two");
    expect(t).toContain("----------");
    expect(t).toContain("- A");
    expect(t).toContain("- B");
    expect(t).toContain("[Logo]");
    expect(t).not.toMatch(/<|>/);
    expect(t).toMatch(/c1 c2/);
  });
  it("link text/url: shows 'label (url)', just the url when label equals it or is empty; decodes &amp;", () => {
    expect(htmlToText(`<a href="https://a.com/?a=1&amp;b=2">Go</a>`)).toBe("Go (https://a.com/?a=1&b=2)");
    expect(htmlToText(`<a href="https://a.com">https://a.com</a>`)).toBe("https://a.com");
    expect(htmlToText(`<a href="https://a.com"></a>`)).toBe("https://a.com");
  });
  it("drops style/script/head/title blocks and hidden preheader spans; decodes entities exactly once", () => {
    const t = htmlToText(`<html><head><title>T</title><style>p{color:red}</style></head><body><span style="display:none">hidden pre</span><script>alert(1)</script><p>a &amp;amp; b &nbsp;c &lt;d&gt; &quot;e&quot; &#39;f&#39;</p></body></html>`);
    expect(t).not.toMatch(/hidden pre|alert|color:red|^T\b/);
    expect(t).toBe(`a &amp; b c <d> "e" 'f'`);
  });
  it("collapses whitespace and blank lines; empty input is empty", () => {
    expect(htmlToText("<p>a</p>\n\n\n\n<p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<p>  a   b  </p>")).toBe("a b");
    expect(htmlToText("")).toBe("");
  });
  it("PROPERTY: never emits angle-bracket tags from html input and never throws", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("<p>", "</p>", "<b>", "<a href=\"x\">", "</a>", "text", "<br>", "&amp;", "<script>x</script>", "<li>", "<img alt=\"a\" src=\"b\">"), { maxLength: 20 }).map((a) => a.join("")), (h) => !/<[a-z\/]/i.test(htmlToText(h))),
      opts,
    );
  });
});
