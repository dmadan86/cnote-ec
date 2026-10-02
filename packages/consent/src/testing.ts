// Source scanners for the per-app registry tests ("a cookie / storage key / third-party script / iframe appeared that the registry
// does not know about"). Test-time only (node:fs): import from "@cnote/consent/testing". Pure string functions are exported
// separately so they are unit-tested on fixtures.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { optionalEntries, stripCookiePrefix, type StorageEntry } from "./registry";

const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "coverage", "generated"]);

/** Every .ts/.tsx file under `dir`, excluding tests, declaration files and build output. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (SKIP_DIRS.has(name)) continue;
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export const read = (file: string): string => readFileSync(file, "utf8");

/** Strips `//` and block comments so a mention in prose is not a use. (String contents are kept: keys are string literals.) */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

export interface Finding {
  line: number;
  what: string;
}

const lineOf = (src: string, index: number) => src.slice(0, index).split("\n").length;

const STORAGE_PATTERNS: [RegExp, string][] = [
  [/\bdocument\.cookie\b/g, "document.cookie"],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/g, "web storage"],
  [/\bcookies\s*\(\s*\)\s*\)?\s*\.set\s*\(/g, "cookies().set"],
  [/\.cookies\.set\s*\(/g, "<response>.cookies.set"],
  [/\b(?:cookieStore|store|jar)\.set\s*\(/g, "cookie store .set"],
  [/\bSet-Cookie\b/gi, "Set-Cookie header"],
];

/** Places that write cookies or browser storage directly. */
export function findStorageWrites(src: string): Finding[] {
  const code = stripComments(src);
  const out: Finding[] = [];
  for (const [re, what] of STORAGE_PATTERNS) for (const m of code.matchAll(re)) out.push({ line: lineOf(code, m.index!), what });
  return out.sort((a, b) => a.line - b.line);
}

/** Quoted string literals that look like one of our storage keys: `"seller_foo"`, `'cnote_bar'`. */
export function findQuotedKeys(src: string, prefix: RegExp): { key: string; line: number }[] {
  const code = stripComments(src);
  const out: { key: string; line: number }[] = [];
  const re = new RegExp(`["'\`]((?:${prefix.source})[A-Za-z0-9_]*)["'\`]`, "g");
  for (const m of code.matchAll(re)) out.push({ key: m[1]!, line: lineOf(code, m.index!) });
  return out;
}

/** Third-party script loading: next/script, a created <script>, or a script tag with a src. */
export function findScriptLoads(src: string): Finding[] {
  const code = stripComments(src);
  const out: Finding[] = [];
  const pats: [RegExp, string][] = [
    [/from\s+["']next\/script["']/g, "next/script import"],
    [/createElement\(\s*["']script["']\s*\)/g, "createElement('script')"],
    [/<script\b[^>]*\bsrc\s*=/gi, "<script src>"],
  ];
  for (const [re, what] of pats) for (const m of code.matchAll(re)) out.push({ line: lineOf(code, m.index!), what });
  return out.sort((a, b) => a.line - b.line);
}

export interface IframeUse {
  line: number;
  /** the literal src when it is a plain string, "dynamic" when it is an expression, null when there is no src (srcDoc) */
  src: string | null;
}

/** Every `<iframe` element with what its `src` is. */
export function findIframes(src: string): IframeUse[] {
  const code = stripComments(src);
  const out: IframeUse[] = [];
  for (const m of code.matchAll(/<iframe\b([\s\S]*?)(?:\/>|>)/g)) {
    const attrs = m[1]!;
    const lit = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    const expr = /\bsrc\s*=\s*\{/.test(attrs);
    out.push({ line: lineOf(code, m.index!), src: lit ? (lit[1] ?? lit[2] ?? "") : expr ? "dynamic" : null });
  }
  return out;
}

/** True when `src` points off our own origin: an absolute http(s)/protocol-relative URL, or a dynamic expression. */
export const isThirdPartySrc = (src: string | null): boolean => src !== null && (src === "dynamic" || /^(?:https?:)?\/\//i.test(src));

/**
 * Third-party `<iframe>`s (absolute / protocol-relative src, or a dynamic `src={...}` expression) that are NOT inside a
 * `<ConsentGate>...</ConsentGate>` element of the same file. Local iframes (relative src) and srcDoc previews are not flagged.
 * The buyer web's test fails on any result: a third-party frame without the gate would load before consent.
 */
export function findUngatedIframes(src: string): IframeUse[] {
  const code = stripComments(src);
  const ranges: [number, number][] = [];
  const stack: number[] = [];
  for (const m of code.matchAll(/<ConsentGate\b|<\/ConsentGate>/g)) {
    if (m[0].startsWith("</")) {
      const start = stack.pop();
      if (start !== undefined) ranges.push([start, m.index!]);
    } else stack.push(m.index!);
  }
  const out: IframeUse[] = [];
  for (const m of code.matchAll(/<iframe\b([\s\S]*?)(?:\/>|>)/g)) {
    const attrs = m[1]!;
    const lit = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs);
    const use: IframeUse = { line: lineOf(code, m.index!), src: lit ? (lit[1] ?? lit[2] ?? "") : /\bsrc\s*=\s*\{/.test(attrs) ? "dynamic" : null };
    if (isThirdPartySrc(use.src) && !ranges.some(([a, b]) => m.index! > a && m.index! < b)) out.push(use);
  }
  return out;
}

export interface NecessaryOnlyAudit {
  /** the app's `src` directory */
  srcDir: string;
  registry: readonly StorageEntry[];
  /** quoted keys of the app that must be in the registry, e.g. /cnote_admin_/ */
  keyPrefix: RegExp;
  /** `src`-relative files allowed to write cookies (none for an app whose cookies are all written by @cnote/next-kit) */
  cookieWriters?: readonly string[];
  /** `src`-relative files allowed to READ document.cookie */
  cookieReaders?: readonly string[];
  /** `src`-relative files that only NAME storage kinds as data (a registry) */
  skip?: readonly string[];
}

/**
 * The invariant for an app with ONLY strictly necessary storage (no banner): the registry holds no optional entry, every quoted key
 * is registered, and the source writes no cookie / web storage, loads no third-party script and renders no third-party iframe except
 * where listed. Returns one message per violation; the app's test asserts the list is empty. The day an optional key appears, the
 * message says what to do (docs/design/cookie-consent.md, "Other apps").
 */
export function auditNecessaryOnlyApp(o: NecessaryOnlyAudit): string[] {
  const problems: string[] = [];
  const names = new Set(o.registry.map((e) => e.name));
  for (const e of optionalEntries(o.registry)) {
    problems.push(`${e.name} is ${e.category}: this app has no consent banner. Add a banner (see apps/seller/src/features/consent), gate the write on consent and bump the policy version, or remove the key.`);
  }
  const writers = new Set(o.cookieWriters ?? []);
  const readers = new Set(o.cookieReaders ?? []);
  const skip = new Set(o.skip ?? []);
  for (const file of sourceFiles(o.srcDir)) {
    const rel = path.relative(o.srcDir, file).split(path.sep).join("/");
    if (skip.has(rel)) continue;
    const src = read(file);
    for (const k of findQuotedKeys(src, o.keyPrefix)) if (!names.has(stripCookiePrefix(k.key))) problems.push(`${rel}:${k.line} mentions "${k.key}", which is not in the storage registry`);
    for (const w of findStorageWrites(src)) {
      const ok = w.what === "document.cookie" ? readers.has(rel) : writers.has(rel);
      if (!ok) problems.push(`${rel}:${w.line} uses ${w.what}: register the key (strictly necessary only), or add consent`);
    }
    for (const s of findScriptLoads(src)) problems.push(`${rel}:${s.line} loads a script (${s.what}): a third-party script needs consent or a documented necessary exemption`);
    for (const i of findIframes(src)) if (isThirdPartySrc(i.src)) problems.push(`${rel}:${i.line} renders an iframe with a third-party src: only ConsentGate may`);
  }
  return problems;
}
