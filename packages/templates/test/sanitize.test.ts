import { describe, expect, it } from "vitest";
import { renderMustache } from "../src/assemble";
import { cleanEmailHtml, cleanPlainText, htmlToText, neutralizeMustache, sanitizeEmailHtml } from "../src/sanitize";

describe("mustache safety", () => {
  it("escapes {{var}} for HTML", () => {
    expect(renderMustache("<p>{{name}}</p>", { name: `<script>alert(1)</script> & "x"` }, true)).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>");
  });
  it("does not escape when rendering plain text", () => {
    expect(renderMustache("Hi {{name}}", { name: "A & B" }, false)).toBe("Hi A & B");
  });
  it("strips triple-stash and ampersand tags (converted to escaped tags)", () => {
    expect(neutralizeMustache("{{{name}}} {{& name}} {{&name}}")).toBe("{{name}} {{name}} {{name}}");
    expect(renderMustache("{{{x}}}", { x: "<b>hi</b>" }, true)).toBe("&lt;b&gt;hi&lt;/b&gt;");
    expect(renderMustache("{{&x}}", { x: "<b>hi</b>" }, true)).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });
  it("drops partials, delimiter changes and malformed tags; keeps sections", () => {
    expect(neutralizeMustache("{{> secret}}{{=<% %>=}}{{ a b }}")).toBe("");
    expect(renderMustache("{{#show}}yes{{/show}}{{^show}}no{{/show}}", { show: true }, true)).toBe("yes");
    expect(renderMustache("{{#show}}yes{{/show}}{{^show}}no{{/show}}", { show: "" }, true)).toBe("no");
  });
  it("removes triple-stash on save (sanitised HTML never contains it)", () => {
    const out = cleanEmailHtml("<p>{{{ body }}} and {{&raw}}</p>");
    expect(out).not.toContain("{{{");
    expect(out).not.toContain("{{&");
    expect(out).toContain("{{body}}");
  });
  it("rejects broken syntax on save", () => {
    expect(() => cleanEmailHtml("<p>{{#a}}open</p>")).toThrow(/syntax error/);
    expect(() => cleanPlainText("{{#a}} x")).toThrow(/syntax error/);
  });
});

describe("sanitizer allowlist", () => {
  it("removes script, event handlers and javascript: urls", () => {
    const out = sanitizeEmailHtml(`<p onclick="x()">a</p><script>alert(1)</script><a href="javascript:alert(1)">l</a><img src="x" onerror="alert(1)"><iframe src="https://e.com"></iframe>`);
    expect(out).not.toMatch(/script|onclick|onerror|javascript|iframe|<img/i);
    expect(out).toContain("<p>a</p>");
  });
  it("allows http/https/mailto links only and adds rel for _blank", () => {
    expect(sanitizeEmailHtml(`<a href="https://a.com" target="_blank">x</a>`)).toBe(`<a href="https://a.com" target="_blank" rel="noopener noreferrer">x</a>`);
    expect(sanitizeEmailHtml(`<a href="mailto:a@b.com">x</a>`)).toContain('href="mailto:a@b.com"');
    expect(sanitizeEmailHtml(`<a href="ftp://a.com">x</a>`)).not.toContain("href");
    expect(sanitizeEmailHtml(`<a href="/relative">x</a>`)).not.toContain("href");
    expect(sanitizeEmailHtml(`<a href="data:text/html,<b>">x</a>`)).not.toContain("href");
  });
  it("keeps template variables in href", () => {
    expect(sanitizeEmailHtml(`<a href="{{resetUrl}}">reset</a>`)).toContain('href="{{resetUrl}}"');
  });
  it("img src must be https or a template asset path", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(sanitizeEmailHtml(`<img src="https://cdn.example.com/a.png" alt="a">`)).toContain("<img");
    expect(sanitizeEmailHtml(`<img src="/media/template-assets/${id}" alt="a">`)).toContain(`/media/template-assets/${id}`);
    expect(sanitizeEmailHtml(`<img src="http://cdn.example.com/a.png">`)).not.toContain("<img");
    expect(sanitizeEmailHtml(`<img src="data:image/png;base64,AAAA">`)).not.toContain("<img");
    expect(sanitizeEmailHtml(`<img src="/media/other/x">`)).not.toContain("<img");
  });
  it("filters style properties and values", () => {
    const out = sanitizeEmailHtml(`<p style="color: #ff0000; text-align: center; position: fixed; background: url(javascript:x); padding: 10px; width: expression(alert(1))">x</p>`);
    expect(out).toContain("color:#ff0000");
    expect(out).toContain("text-align:center");
    expect(out).toContain("padding:10px");
    expect(out).not.toMatch(/position|background:|expression|url\(/);
  });
  it("drops unknown tags/attributes but keeps their text", () => {
    const out = sanitizeEmailHtml(`<section class="x" id="y"><font color="red">hi</font><style>p{}</style></section>`);
    expect(out).toBe("hi");
  });
  it("keeps typical TipTap output", () => {
    const html = `<h2 style="text-align: center">T</h2><p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s> <span style="color: rgb(1, 2, 3)">c</span></p><ul><li><p>a</p></li></ul><blockquote><p>q</p></blockquote><hr>`;
    const out = sanitizeEmailHtml(html);
    for (const t of ["<h2", "<strong>", "<em>", "<u>", "<s>", "<ul>", "<li>", "<blockquote>", "<hr"]) expect(out).toContain(t);
  });
  it("is idempotent", () => {
    const once = sanitizeEmailHtml(`<p style="color:#fff">{{name}} <a href="https://a.com?x=1&y=2">l</a></p>`);
    expect(sanitizeEmailHtml(once)).toBe(once);
  });
});

describe("htmlToText", () => {
  it("produces readable text with links", () => {
    const t = htmlToText(`<h2>Hi &amp; welcome</h2><p>Click <a href="https://a.com/x?a=1&amp;b=2">here</a></p><ul><li>one</li><li>two</li></ul>`);
    expect(t).toContain("Hi & welcome");
    expect(t).toContain("here (https://a.com/x?a=1&b=2)");
    expect(t).toContain("- one");
  });
});
