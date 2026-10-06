import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCsp, isCspHash } from "../src";
import { buildManifest, cspHash, inlineScripts, pageScriptHashes } from "../src/csp-hashes";

const html = (...scripts: string[]) => `<!doctype html><html><head>${scripts.join("")}</head><body><script src="/_next/static/a.js" async></script></body></html>`;
const BOOT = `(function(){document.documentElement.dataset.rail="collapsed"})()`;
const FLIGHT = `self.__next_f.push([1,"0:[\\"$\\",\\"div\\"]"])`;

describe("cspHash", () => {
  it("is the CSP source form of the base64 digest of the exact text, and always a valid hash source", () => {
    expect(cspHash(BOOT)).toBe(`'sha256-${createHash("sha256").update(BOOT).digest("base64")}'`);
    for (const a of ["sha256", "sha384", "sha512"] as const) expect(isCspHash(cspHash("x", a)), a).toBe(true);
    expect(cspHash(" x")).not.toBe(cspHash("x")); // whitespace matters to browsers
  });
});

describe("inlineScripts / pageScriptHashes", () => {
  it("finds inline scripts only; external ones (src) are covered by 'self'", () => {
    const h = html(`<script>${BOOT}</script>`, `<script async>${FLIGHT}</script>`);
    expect(inlineScripts(h).map((s) => s.text)).toEqual([BOOT, FLIGHT]);
  });
  it("skips data blocks (ld+json, importmap) and empty bodies, keeps module and plain scripts", () => {
    const h = html(`<script type="application/ld+json">{"@type":"Product"}</script>`, `<script type="importmap">{}</script>`, `<script></script>`, `<script type="module">import "/x.js"</script>`, `<script type="text/javascript">1</script>`);
    expect(pageScriptHashes(h)).toEqual([cspHash(`import "/x.js"`), cspHash("1")]);
  });
  it("de-duplicates identical scripts", () => {
    expect(pageScriptHashes(html(`<script>${BOOT}</script>`, `<script>${BOOT}</script>`))).toEqual([cspHash(BOOT)]);
  });
  it("the hashes it returns make a valid hash-mode CSP without unsafe-inline for scripts", () => {
    const hs = pageScriptHashes(html(`<script>${BOOT}</script>`, `<script>${FLIGHT}</script>`));
    const csp = buildCsp({ app: "web", scriptHashes: hs, env: {} });
    expect(csp).toContain(`script-src 'self' ${hs.join(" ")}`);
    expect(csp.split("; ").find((d) => d.startsWith("script-src"))).not.toContain("unsafe-inline");
  });
});

describe("buildManifest", () => {
  it("separates shared hashes (bootstrap) from page-specific ones (flight data) and counts them", () => {
    const pages: Record<string, string> = {};
    for (let i = 0; i < 10; i++) pages[`/p${i}`] = html(`<script>${BOOT}</script>`, `<script>self.__next_f.push([1,"page-${i}"])</script>`);
    pages["/static"] = html(`<script>${BOOT}</script>`);
    const m = buildManifest(pages, { sharedShare: 0.9 });
    expect(m.shared).toEqual([cspHash(BOOT)]);
    expect(m.stats).toMatchObject({ pages: 11, distinctHashes: 11, sharedHashes: 1, pagesWithPageSpecificScripts: 10, maxPerPage: 2 });
    expect(m.routes["/static"]).toEqual([cspHash(BOOT)]);
  });
  it("handles an empty site", () => {
    expect(buildManifest({}).stats).toMatchObject({ pages: 0, distinctHashes: 0, maxPerPage: 0 });
  });
});

describe("inlineScripts closing-tag variants", () => {
  it("accepts a closing tag with whitespace or attributes and any case", async () => {
    const { inlineScripts } = await import("../src/csp-hashes");
    expect(inlineScripts("<script>a()</SCRIPT >")[0]?.text).toBe("a()");
    expect(inlineScripts("<script>b()</script foo='x'>")[0]?.text).toBe("b()");
  });
});
