import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUYER_FEATURES, EXPIRY_LABELS, EXPIRY_OPTIONS, SCOPES, SCOPE_GROUPS, SELLER_FEATURES, expiryToDate, hasScope, isScope, scopeGroupDefs,
  scopeNeedsBusiness, scopesFromAccess, type Scope,
} from "../src";
import { generateSecret, hashSecret, isWellFormedSecret, prefixOf, safeEqualHex } from "../src/secret";
import { statusOf, toView } from "../src/keys";
import { dayString } from "../src/usage";

const scopeArb = fc.constantFrom(...SCOPES);
const DAY = 86_400_000;

describe("secret", () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = env;
  });
  it("uses ck_live_ in production and ck_test_ elsewhere; always well formed and unique", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    expect(generateSecret()).toMatch(/^ck_live_/);
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const s = generateSecret();
      expect(s).toMatch(/^ck_test_/);
      expect(isWellFormedSecret(s)).toBe(true);
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });
  it("hash is a deterministic 64-hex sha256 that never contains the secret; prefix is 12 chars of it", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const h = hashSecret(s);
        expect(h).toMatch(/^[0-9a-f]{64}$/);
        expect(h).toBe(hashSecret(s));
        expect(prefixOf(s)).toBe(s.slice(0, 12));
      }),
    );
    expect(hashSecret("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("different secrets hash differently", () => {
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => a === b || hashSecret(a) !== hashSecret(b)));
  });
  it("isWellFormedSecret rejects bad shapes, non-strings and oversize input", () => {
    const ok = `ck_live_${"A".repeat(43)}`;
    expect(isWellFormedSecret(ok)).toBe(true);
    for (const bad of [
      "", ok.slice(1), `${ok}A`, `ck_prod_${"A".repeat(43)}`, `ck_live_${"A".repeat(42)}`, `ck_live_${"A".repeat(42)}!`, ` ${ok}`, `${ok}\n`,
      `ck_live_${"A".repeat(43)}${"A".repeat(50)}`, null, undefined, 42, {}, [ok],
    ]) expect(isWellFormedSecret(bad)).toBe(false);
  });
  it("safeEqualHex", () => {
    expect(safeEqualHex("abc", "abc")).toBe(true);
    expect(safeEqualHex("abc", "abd")).toBe(false);
    expect(safeEqualHex("abc", "abcd")).toBe(false);
    fc.assert(fc.property(fc.string(), fc.string(), (a, b) => safeEqualHex(a, b) === (Buffer.from(a).equals(Buffer.from(b)))));
  });
});

describe("scopes", () => {
  it("isScope is exactly membership of SCOPES", () => {
    fc.assert(fc.property(fc.anything(), (v) => isScope(v) === (typeof v === "string" && (SCOPES as readonly string[]).includes(v))));
    for (const s of SCOPES) expect(isScope(s)).toBe(true);
  });
  it("hasScope: write implies read for same feature, never the converse, never across features", () => {
    for (const s of SCOPES) {
      expect(hasScope({ scopes: [s] }, s)).toBe(true);
      const [feature, level] = s.split(":") as [string, string];
      if (level === "write") expect(hasScope({ scopes: [s] }, `${feature}:read` as Scope)).toBe(true);
      else if ((SCOPES as readonly string[]).includes(`${feature}:write`)) expect(hasScope({ scopes: [s] }, `${feature}:write` as Scope)).toBe(false);
    }
    fc.assert(
      fc.property(fc.array(scopeArb), scopeArb, (held, want) => {
        const [wf, wl] = want.split(":");
        const expected = held.some((h) => {
          const [hf, hl] = h.split(":");
          return hf === wf && (hl === wl || (wl === "read" && hl === "write"));
        });
        return hasScope({ scopes: held }, want) === expected;
      }),
    );
  });
  it("empty scope list holds nothing", () => {
    for (const s of SCOPES) expect(hasScope({ scopes: [] }, s)).toBe(false);
  });
  it("scopeNeedsBusiness matrix: business writes/reads flagged; person-level writes and public reads not", () => {
    const needs = SCOPES.filter(scopeNeedsBusiness).sort();
    expect(needs).toEqual(["billing:read", "enquiries:write", "leads:read", "leads:write", "listings:read", "listings:write"]);
    for (const s of ["wishlist:write", "reviews:write", "messages:write", "profile:read", "search:read", "catalogue:read"] as Scope[]) expect(scopeNeedsBusiness(s)).toBe(false);
  });
  it("scopesFromAccess: write => write scope only, read => read, none/unknown/null ignored; output is a subset of SCOPES without dupes", () => {
    expect(scopesFromAccess({ profile: "write" })).toEqual(["profile:read"]); // no write scope exists: falls back to read
    expect(scopesFromAccess({ leads: "read" })).toEqual(["leads:read"]);
    expect(scopesFromAccess({ leads: null, billing: undefined, x: "read", search: "" })).toEqual([]);
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...Object.keys(SCOPE_GROUPS), "bogus", "__proto__"), fc.constantFrom("none", "read", "write", null, undefined, "admin")),
        (access) => {
          const out = scopesFromAccess(access);
          expect(new Set(out).size).toBe(out.length);
          for (const s of out) expect(isScope(s)).toBe(true);
          for (const [f, lvl] of Object.entries(access)) {
            const g = (SCOPE_GROUPS as Record<string, (typeof SCOPE_GROUPS)[keyof typeof SCOPE_GROUPS] | undefined>)[f];
            if (!g) continue;
            if (lvl === "write" && g.write) expect(out).toContain(g.write);
            if (lvl === "read" && g.read) expect(out).toContain(g.read);
            if (lvl !== "read" && lvl !== "write") {
              for (const sc of [g.read, g.write]) if (sc && !(access as Record<string, unknown>)[f]) expect(out).not.toContain(sc);
              if (lvl === "none" || lvl == null) for (const sc of [g.read, g.write]) if (sc) expect(out).not.toContain(sc);
            }
          }
        },
      ),
    );
  });
  it("groups: every scope belongs to exactly one group; features lists are valid; defs mirror groups", () => {
    const all = Object.values(SCOPE_GROUPS).flatMap((g) => [g.read, g.write].filter(Boolean));
    expect([...all].sort()).toEqual([...SCOPES].sort());
    for (const f of [...BUYER_FEATURES, ...SELLER_FEATURES]) expect(SCOPE_GROUPS[f]).toBeDefined();
    const defs = scopeGroupDefs(SELLER_FEATURES);
    expect(defs.map((d) => d.feature)).toEqual(SELLER_FEATURES);
    const billing = defs.find((d) => d.feature === "billing")!;
    expect(billing).toMatchObject({ hasRead: true, hasWrite: false, businessRead: true, businessWrite: false });
  });
});

describe("expiry", () => {
  it("labels exist for every option", () => {
    for (const o of EXPIRY_OPTIONS) expect(EXPIRY_LABELS[o]).toBeTruthy();
  });
  it("never => null; day options are exact multiples of 24h (property over instants)", () => {
    const dates = fc.date({ min: new Date("2000-01-01"), max: new Date("2100-01-01"), noInvalidDate: true });
    fc.assert(
      fc.property(dates, (now) => {
        expect(expiryToDate("never", now)).toBeNull();
        for (const [o, d] of [["1d", 1], ["7d", 7], ["30d", 30], ["90d", 90]] as const) expect(expiryToDate(o, now)!.getTime() - now.getTime()).toBe(d * DAY);
        const y = expiryToDate("1y", now)!;
        const delta = (y.getTime() - now.getTime()) / DAY;
        expect(delta).toBeGreaterThanOrEqual(365);
        expect(delta).toBeLessThanOrEqual(366 + 1);
        // ordering
        const ts = (["1d", "7d", "30d", "90d", "1y"] as const).map((o) => expiryToDate(o, now)!.getTime());
        expect([...ts].sort((a, b) => a - b)).toEqual(ts);
      }),
    );
  });
  it("does not mutate the input date; defaults to now", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const copy = now.getTime();
    expiryToDate("1y", now);
    expect(now.getTime()).toBe(copy);
    const before = Date.now();
    expect(expiryToDate("1d")!.getTime()).toBeGreaterThanOrEqual(before + DAY);
  });
  it("1y from a leap day rolls to Mar 1 (documented JS behaviour)", () => {
    expect(expiryToDate("1y", new Date("2028-02-29T00:00:00Z"))!.toISOString()).toBe("2029-03-01T00:00:00.000Z");
  });
});

describe("status / view", () => {
  const now = new Date("2026-06-01T00:00:00Z");
  it("revoked beats expired beats active; expiry boundary is inclusive", () => {
    expect(statusOf({ revokedAt: null, expiresAt: null }, now)).toBe("active");
    expect(statusOf({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now)).toBe("active");
    expect(statusOf({ revokedAt: null, expiresAt: new Date(now.getTime()) }, now)).toBe("expired");
    expect(statusOf({ revokedAt: new Date(0), expiresAt: new Date(now.getTime() - 1) }, now)).toBe("revoked");
  });
  it("toView filters unknown scopes and never exposes a hash", () => {
    const v = toView(
      { id: "i", name: "n", prefix: "ck_test_abcd", scopes: ["profile:read", "legacy:thing"], businessId: null, expiresAt: null, lastUsedAt: new Date(0), lastUsedIp: "1.1.1.1", revokedAt: null, createdAt: new Date(0), secretHash: "h" } as never,
      now,
    );
    expect(v.scopes).toEqual(["profile:read"]);
    expect(v.lastUsedAt).toBe("1970-01-01T00:00:00.000Z");
    expect(JSON.stringify(v)).not.toContain('"secretHash"');
  });
  it("dayString is UTC yyyy-mm-dd", () => {
    expect(dayString(new Date("2026-01-01T23:59:59Z"))).toBe("2026-01-01");
    expect(dayString(new Date("2026-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});
