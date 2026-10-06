import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_CLIENT_NAMESPACES, CLIENT_NAMESPACES } from "../src/i18n/messages";

/**
 * A "use client" component can only read namespaces the layout passes to the client provider. A namespace missing from
 * CLIENT_NAMESPACES / APP_CLIENT_NAMESPACES renders raw keys ("rfqLines.modeOne") that axe cannot flag, so every namespace a
 * client component reads must be listed. Pages that build their own provider (help, pricing calculator) are listed here.
 */
const OWN_PROVIDER = new Set(["help", "pricing2"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("client message namespaces", () => {
  it("lists every namespace read by a client component", () => {
    const known = new Set<string>([...CLIENT_NAMESPACES, ...APP_CLIENT_NAMESPACES, ...OWN_PROVIDER]);
    const missing: string[] = [];
    for (const file of walk(join(__dirname, "../src"))) {
      const src = readFileSync(file, "utf8");
      if (!/^["']use client["']/.test(src)) continue;
      for (const m of src.matchAll(/useTranslations\("([A-Za-z0-9]+)/g)) {
        if (!known.has(m[1]!)) missing.push(`${file.split("/src/")[1]}: ${m[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
