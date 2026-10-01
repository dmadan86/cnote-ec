import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import hi from "../messages/hi.json";
import { CATEGORIES, clientClearable, entriesOf, STORAGE_REGISTRY } from "@/features/consent/registry";

const SRC = join(__dirname, "..", "src");
const REPO = join(__dirname, "..", "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "node_modules" || f === ".next" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

/** Every quoted `cnote_*` literal in the app source: a cookie or storage key, a cookie-name constant or a docs string. */
const KEY_RE = /["'](cnote_[a-z0-9_]+)["']/g;

describe("cookie registry (single source of truth)", () => {
  const names = STORAGE_REGISTRY.map((e) => e.name);

  it("has unique names and only the three known categories", () => {
    expect(new Set(names).size).toBe(names.length);
    expect(CATEGORIES).toEqual(["necessary", "analytics", "marketing"]);
    for (const e of STORAGE_REGISTRY) expect(CATEGORIES).toContain(e.category);
  });

  it("lists every cnote_* cookie/storage key that apps/web source writes or reads", () => {
    const found = new Map<string, string>();
    for (const file of walk(SRC)) {
      if (file.includes(join("features", "consent", "registry.ts"))) continue;
      for (const m of readFileSync(file, "utf8").matchAll(KEY_RE)) found.set(m[1]!, file.replace(SRC, "src"));
    }
    const missing = [...found].filter(([k]) => !names.includes(k)).map(([k, f]) => `${k} (${f})`);
    expect(missing, "add these to src/features/consent/registry.ts (and see docs/design/cookie-consent.md)").toEqual([]);
    // the scan actually sees the important ones (guards against a broken regex / moved sources)
    for (const k of ["cnote_consent", "cnote_vid", "cnote_ad_click", "cnote_locale", "cnote_rail", "cnote_pincode", "cnote_lg_v1", "cnote_attr"]) expect(found.has(k), k).toBe(true);
  });

  it("covers the cookies defined in shared packages (auth, OAuth/MFA challenge, compare tray)", () => {
    const wishlist = readFileSync(join(REPO, "packages/wishlist/src/compare.ts"), "utf8");
    expect(/COMPARE_COOKIE = "(cnote_[a-z_]+)"/.exec(wishlist)?.[1]).toBe("cnote_compare");
    expect(readFileSync(join(REPO, "packages/identity/src/constants.ts"), "utf8")).toContain("`${p}cnote_${realm}_at`");
    expect(readFileSync(join(REPO, "packages/next-kit/src/cookies.ts"), "utf8")).toContain("`cnote_${appRealm()}_oauth`");
    expect(readFileSync(join(REPO, "packages/next-kit/src/mfa-flow.ts"), "utf8")).toContain("cnote_${appRealm()}_mfa");
    for (const k of ["cnote_compare", "cnote_web_at", "cnote_web_rt", "cnote_web_oauth", "cnote_web_mfa"]) expect(names).toContain(k);
  });

  it("classifies tracking as consent-gated and user-requested state as strictly necessary", () => {
    const cat = (n: string) => STORAGE_REGISTRY.find((e) => e.name === n)?.category;
    for (const n of ["cnote_vid", "cnote_ad_click", "cnote_attr", "cnote_lg_v1", "cnote_lg_views", "cnote_lg_session"]) expect(cat(n), n).toBe("marketing");
    for (const n of ["cnote_consent", "cnote_web_at", "cnote_web_rt", "cnote_locale", "cnote_rail", "cnote_pincode", "cnote_lang_suggestion_dismissed", "cnote_voice_consent_v1"]) expect(cat(n), n).toBe("necessary");
    for (const n of ["_clck", "_clsk"]) expect(cat(n), n).toBe("analytics");
    expect(entriesOf("necessary").every((e) => e.provider === "firstParty")).toBe(true);
    expect(entriesOf("analytics").every((e) => e.provider === "clarity")).toBe(true);
  });

  it("marks only the server-set cookies httpOnly and never lets client cleanup touch them", () => {
    const http = STORAGE_REGISTRY.filter((e) => e.httpOnly).map((e) => e.name);
    expect(http.sort()).toEqual(["cnote_ad_click", "cnote_web_at", "cnote_web_mfa", "cnote_web_oauth", "cnote_web_rt"]);
    for (const c of ["analytics", "marketing"] as const) for (const e of clientClearable(c)) expect(e.httpOnly).toBeFalsy();
    expect(clientClearable("analytics").map((e) => e.name)).toEqual(expect.arrayContaining(["_clck", "_clsk"]));
  });

  it("has a purpose, kind, provider and duration message in en and hi for every entry", () => {
    const purposes = (en.consent as { purpose: Record<string, string> }).purpose;
    const hiPurposes = (hi.consent as { purpose: Record<string, string> }).purpose;
    for (const e of STORAGE_REGISTRY) {
      expect(purposes[e.purpose], `${e.name} en purpose`).toBeTruthy();
      expect(hiPurposes[e.purpose], `${e.name} hi purpose`).toMatch(/[ऀ-ॿ]/);
      expect((en.consent.kind as Record<string, string>)[e.kind]).toBeTruthy();
      expect((en.consent.provider as Record<string, string>)[e.provider]).toBeTruthy();
      expect((en.consent.duration as Record<string, string>)[e.duration.unit]).toBeTruthy();
    }
  });
});
