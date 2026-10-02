import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { firstParty } from "../src";
import { auditNecessaryOnlyApp, findIframes, findUngatedIframes, findQuotedKeys, findScriptLoads, findStorageWrites, isThirdPartySrc, read, sourceFiles, stripComments } from "../src/testing";

describe("source scanners (used by the per-app registry tests)", () => {
  it("strips comments but keeps string literals (URLs contain //)", () => {
    expect(stripComments('const a = "https://x.test"; // localStorage here\n/* document.cookie */ b()')).toBe('const a = "https://x.test"; \n b()');
  });

  it("finds cookie and storage writes, not mentions in comments", () => {
    const src = [
      "// localStorage is not used",
      "document.cookie = `a=1`;",
      "localStorage.setItem('k','v');",
      "sessionStorage.getItem('k');",
      "(await cookies()).set('a','1');",
      "res.cookies.set('a','1');",
      "cookieStore.set('a','1');",
      "headers.set('Set-Cookie', x);",
      "indexedDB.open('x');",
    ].join("\n");
    const hits = findStorageWrites(src);
    expect(hits.map((h) => h.what)).toEqual(["document.cookie", "web storage", "web storage", "cookies().set", "<response>.cookies.set", "cookie store .set", "Set-Cookie header", "web storage"]);
    expect(hits[0]!.line).toBe(2);
    expect(findStorageWrites("const x = 1; // document.cookie")).toEqual([]);
  });

  it("finds quoted keys by prefix, ignoring comments and unquoted mentions", () => {
    const src = ['const A = "seller_ref";', "const B = 'cnote_seller_at';", "const C = `seller_locale`;", '// "seller_comment"', "const d = seller_unquoted;"].join("\n");
    expect(findQuotedKeys(src, /seller_|cnote_seller_/).map((k) => k.key)).toEqual(["seller_ref", "cnote_seller_at", "seller_locale"]);
  });

  it("finds third-party script loading", () => {
    const src = ['import Script from "next/script";', 'const s = document.createElement("script");', '<script src="https://x.test/a.js" />', "<script>inline()</script>"].join("\n");
    expect(findScriptLoads(src).map((f) => f.what)).toEqual(["next/script import", "createElement('script')", "<script src>"]);
  });

  it("finds iframes and what their src is: literal, dynamic or absent (srcDoc)", () => {
    const src = [
      '<iframe src="https://www.youtube-nocookie.com/embed/x" title="a" />',
      "<iframe\n  src={url}\n  title=\"b\"\n/>",
      "<iframe srcDoc={html} sandbox=\"\"></iframe>",
      "<iframe src='/local/page' />",
    ].join("\n");
    const frames = findIframes(src);
    expect(frames.map((f) => f.src)).toEqual(["https://www.youtube-nocookie.com/embed/x", "dynamic", null, "/local/page"]);
    expect(frames.map((f) => isThirdPartySrc(f.src))).toEqual([true, true, false, false]);
    expect(isThirdPartySrc("//cdn.test/x")).toBe(true);
    expect(isThirdPartySrc("http://x.test")).toBe(true);
  });

  it("flags third-party iframes outside a ConsentGate, and only those", () => {
    const gated = '<ConsentGate category="marketing" provider="YouTube">\n  <iframe src={src} title="v" />\n</ConsentGate>';
    expect(findUngatedIframes(gated)).toEqual([]);
    expect(findUngatedIframes('<ConsentGate a="b"><div><iframe src="https://x.test/e" /></div></ConsentGate>')).toEqual([]);
    expect(findUngatedIframes('<iframe src="https://x.test/e" />')).toEqual([{ line: 1, src: "https://x.test/e" }]);
    expect(findUngatedIframes("<iframe src={url} title=\"t\" />")).toEqual([{ line: 1, src: "dynamic" }]);
    // after the gate closed, the next frame is ungated again; nested gates close correctly
    expect(findUngatedIframes(`${gated}\n<iframe src='//cdn.test/x' />`)).toEqual([{ line: 4, src: "//cdn.test/x" }]);
    expect(findUngatedIframes('<ConsentGate><ConsentGate><iframe src={a} /></ConsentGate><iframe src={b} /></ConsentGate>')).toEqual([]);
    // local, srcDoc and commented-out frames are fine
    expect(findUngatedIframes('<iframe src="/local/page" /><iframe srcDoc={h} sandbox="" />// <iframe src="https://x.test" />')).toEqual([]);
    // a stray closing tag does not break the scan
    expect(findUngatedIframes('</ConsentGate><iframe src={a} />')).toEqual([{ line: 1, src: "dynamic" }]);
  });

  describe("auditNecessaryOnlyApp", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "consent-audit-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const registry = [firstParty("app_at", "necessary", "cookie", "auth", { unit: "minutes", n: 15 }, true)];
    const put = (name: string, body: string) => {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), body);
    };
    const audit = (o: Partial<Parameters<typeof auditNecessaryOnlyApp>[0]> = {}) => auditNecessaryOnlyApp({ srcDir: dir, registry, keyPrefix: /app_/, ...o });

    it("passes for an app with only registered, necessary storage", () => {
      put("clean.ts", 'export const a = "app_at";\nexport const b = "unrelated";\n');
      put("frame.tsx", "export const f = <iframe srcDoc={x} title=\"t\" />;\n");
      expect(audit()).toEqual([]);
    });
    it("reports optional entries, unregistered keys, storage writes, scripts and third-party iframes with the file and line", () => {
      put("bad.tsx", ['const k = "app_new";', "localStorage.setItem(k, 1);", 'import S from "next/script";', '<iframe src="https://t.test/x" />'].join("\n"));
      put("reader.ts", "const c = document.cookie;\n");
      put("writer.ts", "res.cookies.set('app_at', 'x');\n");
      put("ignored.ts", 'localStorage.setItem("app_zzz", 1);\n');
      const out = audit({ registry: [...registry, firstParty("app_t0", "analytics", "cookie", "t", { unit: "years", n: 1 })], cookieReaders: ["reader.ts"], cookieWriters: ["writer.ts"], skip: ["ignored.ts"] });
      expect(out).toEqual(
        expect.arrayContaining([
          expect.stringContaining("app_t0 is analytics: this app has no consent banner"),
          'bad.tsx:1 mentions "app_new", which is not in the storage registry',
          expect.stringContaining("bad.tsx:2 uses web storage"),
          expect.stringContaining("bad.tsx:3 loads a script"),
          expect.stringContaining("bad.tsx:4 renders an iframe with a third-party src"),
        ]),
      );
      expect(out.some((p) => p.startsWith("reader.ts") || p.startsWith("writer.ts") || p.startsWith("ignored.ts"))).toBe(false);
      expect(audit({ cookieWriters: [], cookieReaders: [] }).some((p) => p.startsWith("writer.ts:1 uses <response>.cookies.set"))).toBe(true);
      expect(audit({ cookieWriters: [], cookieReaders: [] }).some((p) => p.startsWith("reader.ts:1 uses document.cookie"))).toBe(true);
    });
  });

  describe("sourceFiles", () => {
    const root = mkdtempSync(path.join(tmpdir(), "consent-scan-"));
    afterAll(() => rmSync(root, { recursive: true, force: true }));
    it("lists .ts/.tsx sources, skipping tests, declarations, build output and node_modules", () => {
      mkdirSync(path.join(root, "a/node_modules/x"), { recursive: true });
      mkdirSync(path.join(root, "a/.next"), { recursive: true });
      for (const f of ["a/one.ts", "a/two.tsx", "a/skip.test.ts", "a/skip.spec.tsx", "a/types.d.ts", "a/readme.md", "a/node_modules/x/n.ts", "a/.next/b.ts"]) writeFileSync(path.join(root, f), "export {};\n");
      expect(sourceFiles(root).map((f) => path.relative(root, f))).toEqual(["a/one.ts", "a/two.tsx"]);
      expect(read(path.join(root, "a/one.ts"))).toBe("export {};\n");
    });
  });
});
