import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Source scan of `new DomainError(code, message, details?, key, params?)` calls with an explicit key (test helper). */
export interface KeyedSite {
  file: string;
  key: string;
  /** English message; `${expr}` placeholders are rewritten to the ICU `{name}` used by the params object */
  message: string;
  params: string[];
}

const PACKAGES = join(__dirname, "..", "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "test") return [];
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

function skipTemplate(s: string, from: number): number {
  let k = from + 2;
  let depth = 1;
  while (depth) {
    if (s[k] === "{") depth++;
    else if (s[k] === "}") depth--;
    k++;
  }
  return k - 1;
}

/** Splits the argument text of a call at top-level commas. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j]!;
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      else if (quote === "`" && c === "$" && s[j + 1] === "{") j = skipTemplate(s, j);
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, j));
      start = j + 1;
    }
  }
  if (s.slice(start).trim()) out.push(s.slice(start));
  return out.map((a) => a.trim());
}

function callBody(s: string, from: number): string {
  let depth = 1;
  let quote: string | null = null;
  let j = from;
  while (depth && j < s.length) {
    const c = s[j]!;
    if (quote) {
      if (c === "\\") j++;
      else if (c === quote) quote = null;
      else if (quote === "`" && c === "$" && s[j + 1] === "{") j = skipTemplate(s, j);
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    j++;
  }
  return s.slice(from, j - 1);
}

/** Param names of an object literal such as `{ max, sku: data.sku }`. */
export function paramNames(obj: string | undefined): string[] {
  if (!obj) return [];
  return splitArgs(obj.replace(/^\{/, "").replace(/\}$/, "")).map((p) => p.split(":")[0]!.trim()).filter(Boolean);
}

/** Every DomainError call in packages/*\/src that passes a literal key as its 4th argument. */
export function scanKeyedSites(): KeyedSite[] {
  const sites: KeyedSite[] = [];
  for (const pkg of readdirSync(PACKAGES)) {
    const src = join(PACKAGES, pkg, "src");
    if (!statSync(src, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const file of sources(src)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/new DomainError\(/g)) {
        const lineStart = text.lastIndexOf("\n", m.index!) + 1;
        if (/^\s*(\/\/|\*|\/\*)/.test(text.slice(lineStart, m.index!))) continue; // documentation example
        const args = splitArgs(callBody(text, m.index! + m[0].length));
        const key = /^"([A-Za-z][A-Za-z]*\.[A-Za-z]+)"$/.exec(args[3] ?? "")?.[1];
        if (!key || args.length < 2) continue;
        const raw = args[1]!;
        let message: string | undefined;
        const names: string[] = [];
        if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) message = JSON.parse(raw) as string;
        else if (/^'(?:[^'\\]|\\.)*'$/.test(raw)) message = raw.slice(1, -1).replace(/\\'/g, "'");
        else if (raw.startsWith("`") && raw.endsWith("`")) {
          const exprs: string[] = [];
          const body = raw.slice(1, -1).replace(/\$\{([^{}]*)\}/g, (_x, e: string) => {
            exprs.push(e);
            return `\u0000${exprs.length - 1}\u0000`;
          });
          message = body;
          names.push(...paramNames(args[4]));
          // map placeholders positionally onto the params object names
          const list = names;
          message = message.replace(/\u0000(\d+)\u0000/g, (_x, i: string) => `{${list[Number(i)] ?? `?${i}`}}`);
        } else continue;
        sites.push({ file, key, message, params: paramNames(args[4]) });
      }
    }
  }
  return sites;
}
