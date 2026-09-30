import { describe, expect, it } from "vitest";
import { trustFactor as searchTrustFactor } from "../../search/src/fusion";
import { classifyUserAgent, realtimeVerdict } from "../src/clicks";
import { adsConfigSchema, isAdsEnabled, resolveAdsConfig } from "../src/config";
import { judgeEligibility } from "../src/eligibility";
import { resolveRate, type RateRow } from "../src/rate-card";
import {
  keywordRelevance, mergeSponsored, paceDecision, placeSlots, rankScored, relevanceOf, slotAllowance, titleRelevance, trustFactor, normaliseKeyword, categoryTargetOk,
} from "../src/relevance";
import { hashNet, hashVisitor, coarseIp, signClickToken, verifyClickToken, type ClickTokenPayload } from "../src/tokens";
import { hourKey, istDate, istDayFraction, istDayStart } from "../src/time";

const cfg = adsConfigSchema.parse({});

describe("config", () => {
  it("founder defaults", () => {
    expect(cfg).toMatchObject({ trustFloor: 50, minVerificationTier: 1, revenueCapPct: 20, maxSearchSlots: 2, perOrganicResults: 10, maxAdShare: 0.2, attributionWindowDays: 7, invalidClickRescoreHours: 72 });
  });
  it("ADS_ENABLED defaults to false", () => {
    expect(isAdsEnabled({})).toBe(false);
    expect(isAdsEnabled({ ADS_ENABLED: "false" })).toBe(false);
    expect(isAdsEnabled({ ADS_ENABLED: "true" })).toBe(true);
    expect(isAdsEnabled({ ADS_ENABLED: "1" })).toBe(true);
  });
  it("env < DB rows; invalid values are ignored; the trust floor can never go below 50", () => {
    expect(resolveAdsConfig([], { ADS_TRUST_FLOOR: "60" } as never).trustFloor).toBe(60);
    expect(resolveAdsConfig([{ key: "trustFloor", value: 70 }], { ADS_TRUST_FLOOR: "60" } as never).trustFloor).toBe(70);
    expect(resolveAdsConfig([{ key: "trustFloor", value: 10 }], {} as never).trustFloor).toBe(50);
    expect(resolveAdsConfig([{ key: "nope", value: 1 }, { key: "minRelevance", value: "x" }], {} as never).minRelevance).toBe(0.3);
    expect(resolveAdsConfig([], { ADS_MIN_TIER: "0" } as never).minVerificationTier).toBe(1);
  });
});

describe("trust factor parity with organic ranking (one definition of trust weighting)", () => {
  it.each([[0, false], [50, false], [50, true], [100, true], [120, false], [-5, false]])("trust %s badge %s", (trustScore, badgeActive) => {
    expect(trustFactor({ trustScore, badgeActive })).toBe(searchTrustFactor({ trustScore, badgeActive }));
  });
});

describe("relevance", () => {
  const base = { requestChain: [], negatives: [], title: "", listingChain: ["leaf", "root"], targetCategories: [], keywords: [] };
  it("keyword match types", () => {
    expect(keywordRelevance("cosmetic boxes", { n: "cosmetic boxes", m: "exact" })).toBe(1);
    expect(keywordRelevance("cosmetic box", { n: "cosmetic boxes", m: "exact" })).toBe(1); // plural fold
    expect(keywordRelevance("red cosmetic boxes", { n: "cosmetic boxes", m: "exact" })).toBe(0);
    expect(keywordRelevance("red cosmetic boxes", { n: "cosmetic boxes", m: "phrase" })).toBe(0.8);
    expect(keywordRelevance("boxes for cosmetics", { n: "cosmetic boxes", m: "phrase" })).toBe(0);
    expect(keywordRelevance("cosmetic bags", { n: "cosmetic boxes", m: "broad" })).toBeCloseTo(0.25);
    expect(keywordRelevance("", { n: "x y", m: "broad" })).toBe(0);
    expect(keywordRelevance("abc", { n: "", m: "phrase" })).toBe(0);
  });
  it("negative keywords remove the ad", () => {
    expect(relevanceOf({ ...base, query: "free cosmetic boxes", keywords: [{ n: "cosmetic boxes", m: "phrase" }], negatives: ["free"] })).toBe(0);
    expect(relevanceOf({ ...base, query: "cosmetic boxes", keywords: [{ n: "cosmetic boxes", m: "phrase" }], negatives: ["free"] })).toBe(1);
  });
  it("needs a real match signal; similarity refines but cannot create one", () => {
    expect(relevanceOf({ ...base, query: "tractor", title: "cosmetic box", similarity: 1 })).toBe(0);
    const a = relevanceOf({ ...base, query: "cosmetic box", keywords: [{ n: "cosmetic box", m: "exact" }], similarity: 0 });
    const b = relevanceOf({ ...base, query: "cosmetic box", keywords: [{ n: "cosmetic box", m: "exact" }], similarity: 1 });
    expect(a).toBeCloseTo(0.75);
    expect(b).toBe(1);
  });
  it("title overlap and category-only matches are capped (0.6 / 0.4)", () => {
    expect(titleRelevance("cosmetic box", "Cosmetic Box premium")).toBeCloseTo(0.6);
    expect(titleRelevance("", "x")).toBe(0);
    expect(relevanceOf({ ...base, query: "", requestChain: ["leaf", "root"] })).toBe(0.4);
    expect(relevanceOf({ ...base, query: "", requestChain: ["other"] })).toBe(0);
  });
  it("category targeting restricts by listing or request ancestry", () => {
    expect(categoryTargetOk({ requestChain: [], listingChain: ["leaf", "root"], targetCategories: ["root"] })).toBe(true);
    expect(categoryTargetOk({ requestChain: ["c2", "root2"], listingChain: ["leaf", "root"], targetCategories: ["root2"] })).toBe(true);
    expect(categoryTargetOk({ requestChain: ["c2"], listingChain: ["leaf"], targetCategories: ["zzz"] })).toBe(false);
    expect(relevanceOf({ ...base, query: "box", title: "box", targetCategories: ["zzz"] })).toBe(0);
  });
  it("normalises keywords like search does", () => {
    expect(normaliseKeyword("  Cosmetic  Boxes ke liye ")).toBe("cosmetic boxes");
  });
});

describe("ranking", () => {
  it("near ties rotate by seed; clear quality gaps do not", () => {
    const items = [{ id: "a", score: 1 }, { id: "b", score: 1.01 }, { id: "c", score: 0.4 }];
    const firsts = new Set(Array.from({ length: 40 }, (_, i) => rankScored(items, 0.05, `seed${i}`)[0]!.id));
    expect(firsts).toEqual(new Set(["a", "b"]));
    for (let i = 0; i < 20; i++) expect(rankScored(items, 0.05, `s${i}`)[2]!.id).toBe("c");
    expect(rankScored(items, 0.05, "x")).toEqual(rankScored(items, 0.05, "x"));
  });
  it("price is not an input: score is only relevance x trust", () => {
    expect(trustFactor({ trustScore: 100, badgeActive: true })).toBeCloseTo(1.03);
  });
});

describe("slot rules", () => {
  it("search/category: none below 10 organic results, at most 2, 1 per 10, never above 20% of cards", () => {
    expect(slotAllowance("search", 9, undefined, cfg)).toBe(0);
    expect(slotAllowance("search", 10, undefined, cfg)).toBe(1);
    expect(slotAllowance("search", 19, undefined, cfg)).toBe(1);
    expect(slotAllowance("search", 20, undefined, cfg)).toBe(2);
    expect(slotAllowance("category", 200, undefined, cfg)).toBe(2);
    expect(slotAllowance("search", 200, 1, cfg)).toBe(1);
    for (let n = 0; n < 120; n++) {
      const a = slotAllowance("search", n, undefined, cfg);
      expect(a / (n + a || 1)).toBeLessThanOrEqual(0.2 + 1e-9);
    }
  });
  it("product page rail: up to 2; unsupported surfaces get none", () => {
    expect(slotAllowance("product_similar", 0, undefined, cfg)).toBe(2);
    expect(slotAllowance("home_rail", 100, undefined, cfg)).toBe(0);
    expect(slotAllowance("brand_banner", 100, undefined, cfg)).toBe(0);
  });
  it("placement: first slots form the top block, extras follow every 10th result", () => {
    expect(placeSlots(2, 10)).toEqual([{ slot: 1, after: "top" }, { slot: 2, after: "top" }]);
    expect(placeSlots(4, 10)).toEqual([{ slot: 1, after: "top" }, { slot: 2, after: "top" }, { slot: 3, after: 10 }, { slot: 4, after: 20 }]);
    expect(placeSlots(0, 10)).toEqual([]);
  });
  it("merge never reorders organic, never duplicates, and empty slots collapse", () => {
    const organic = ["o1", "o2", "o3"].map((id) => ({ id }));
    const m = mergeSponsored(organic, [{ id: "a1", after: "top" as const }, { id: "o2", after: "top" as const }, { id: "a2", after: 2 }]);
    expect(m.top.map((t) => t.id)).toEqual(["a1"]);
    expect(m.feed.map((f) => f.item.id)).toEqual(["o1", "o2", "a2", "o3"]);
    expect(mergeSponsored(organic, []).feed.map((f) => f.item.id)).toEqual(["o1", "o2", "o3"]);
  });
});

describe("pacing", () => {
  const b = { dailyBudgetPaise: 10_000, cpcPaise: 500, dayFraction: 0.1, paceMultiplier: 1.2 };
  it("never past the daily budget", () => {
    expect(paceDecision({ ...b, spentPaise: 9600, random: 0 })).toEqual({ allowed: false, reason: "budget" });
    expect(paceDecision({ ...b, spentPaise: 9500, dayFraction: 1, random: 0 }).allowed).toBe(true);
  });
  it("exploration allowance, on-pace serves, ahead-of-pace throttles", () => {
    expect(paceDecision({ ...b, spentPaise: 0, random: 0.99 }).allowed).toBe(true);
    expect(paceDecision({ ...b, spentPaise: 1000, dayFraction: 0.5, random: 0.99 }).allowed).toBe(true);
    expect(paceDecision({ ...b, spentPaise: 4000, random: 0.99 })).toEqual({ allowed: false, reason: "pacing" });
    expect(paceDecision({ ...b, spentPaise: 4000, random: 0 }).allowed).toBe(true);
  });
});

describe("eligibility matrix", () => {
  const ok = { trust: { trustScore: 60, verificationTier: 1 }, listing: { pricePaise: 100, imageUrls: ["/i"], status: "published" as const, moderationStatus: "approved" as const }, categoryProhibited: false, hasRate: true, cfg: { trustFloor: 50, minVerificationTier: 1 } };
  it.each([
    ["eligible", {}, true, undefined],
    ["no seller", { trust: undefined }, false, "seller_unknown"],
    ["tier 0", { trust: { trustScore: 90, verificationTier: 0 } }, false, "tier_below_min"],
    ["trust 49", { trust: { trustScore: 49, verificationTier: 2 } }, false, "trust_below_floor"],
    ["trust exactly floor", { trust: { trustScore: 50, verificationTier: 1 } }, true, undefined],
    ["unpublished", { listing: undefined }, false, "listing_unpublished"],
    ["draft", { listing: { ...ok.listing, status: "draft" as const } }, false, "listing_unpublished"],
    ["not approved", { listing: { ...ok.listing, moderationStatus: "review" as const } }, false, "listing_unpublished"],
    ["no image", { listing: { ...ok.listing, imageUrls: [] } }, false, "no_approved_image"],
    ["no price", { listing: { ...ok.listing, pricePaise: null } }, false, "no_price"],
    ["prohibited", { categoryProhibited: true }, false, "category_prohibited"],
    ["no rate", { hasRate: false }, false, "no_rate_card"],
    ["configurable floor", { cfg: { trustFloor: 70, minVerificationTier: 1 } }, false, "trust_below_floor"],
    ["configurable tier", { cfg: { trustFloor: 50, minVerificationTier: 2 } }, false, "tier_below_min"],
  ])("%s", (_n, over, eligible, reason) => {
    const v = judgeEligibility({ ...ok, ...over } as never);
    expect(v.eligible).toBe(eligible);
    if (!v.eligible) expect(v.reason).toBe(reason);
  });
});

describe("rate card resolution", () => {
  const d = (s: string) => new Date(s);
  const rows: RateRow[] = [
    { id: "1", categoryId: null, surface: "search", cpcPaise: 300, maxCpcPaise: null, effectiveFrom: d("2026-01-01") },
    { id: "2", categoryId: null, surface: "search", cpcPaise: 400, maxCpcPaise: null, effectiveFrom: d("2026-06-01") },
    { id: "3", categoryId: "root", surface: "search", cpcPaise: 900, maxCpcPaise: 700, effectiveFrom: d("2026-01-01") },
    { id: "4", categoryId: "leaf", surface: "search", cpcPaise: 500, maxCpcPaise: null, effectiveFrom: d("2027-01-01") },
  ];
  it("nearest category wins, latest in-force version wins, max cpc caps, future rows wait", () => {
    expect(resolveRate(rows, ["leaf", "root"], "search", d("2026-09-30"))).toEqual({ id: "3", cpcPaise: 700 });
    expect(resolveRate(rows, ["leaf", "root"], "search", d("2027-02-01"))).toEqual({ id: "4", cpcPaise: 500 });
    expect(resolveRate(rows, ["other"], "search", d("2026-09-30"))).toEqual({ id: "2", cpcPaise: 400 });
    expect(resolveRate(rows, ["other"], "search", d("2026-03-01"))).toEqual({ id: "1", cpcPaise: 300 });
    expect(resolveRate(rows, ["other"], "category", d("2026-09-30"))).toBeNull();
    expect(resolveRate(rows, [], "search", d("2025-01-01"))).toBeNull();
  });
});

describe("click tokens", () => {
  const p: ClickTokenPayload = { t: "tok1", c: "c", g: "g", l: "l", s: "s", f: "search", n: 1, p: 500, q: "box", i: 1_000_000 };
  it("round-trips, detects tampering and expiry", () => {
    const t = signClickToken(p);
    expect(verifyClickToken(t, 30, 1_000_500)).toEqual({ ok: true, payload: p, expired: false });
    expect(verifyClickToken(t, 30, 1_000_000 + 31 * 60_000)).toMatchObject({ ok: true, expired: true });
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ ...p, p: 1 })).toString("base64url");
    expect(verifyClickToken(`${forged}.${sig}`, 30, 1_000_500).ok).toBe(false); // cannot reprice
    expect(verifyClickToken(`${body}.AAAA`, 30).ok).toBe(false);
    expect(verifyClickToken("garbage", 30).ok).toBe(false);
    expect(verifyClickToken(`${body}.${sig}.x`, 30).ok).toBe(false);
    expect(verifyClickToken(`${Buffer.from("{}").toString("base64url")}.${sig}`, 30).ok).toBe(false);
  });
  it("hashes are salted, stable within a week and coarse for networks", () => {
    const now = new Date("2026-09-30T00:00:00Z");
    expect(hashVisitor("v1", now)).toBe(hashVisitor("v1", now));
    expect(hashVisitor("v1", now)).not.toBe(hashVisitor("v1", new Date("2026-11-30T00:00:00Z")));
    expect(hashNet("10.1.2.3", now)).toBe(hashNet("10.1.2.99", now));
    expect(hashNet("10.1.2.3", now)).not.toBe(hashNet("10.1.3.3", now));
    expect(coarseIp("::ffff:1.2.3.4")).toBe("1.2.3.0/24");
    expect(coarseIp("2001:db8:abcd:1::1")).toBe("2001:db8:abcd::/48");
    expect(coarseIp(null)).toBe("none");
    expect(coarseIp("weird")).toBe("other");
  });
});

describe("click rules", () => {
  it("user agents", () => {
    const pats = cfg.botUserAgentPatterns;
    expect(classifyUserAgent("Mozilla/5.0 (Windows NT 10.0) Chrome/120", pats)).toBe("browser");
    expect(classifyUserAgent("Googlebot/2.1", pats)).toBe("bot");
    expect(classifyUserAgent("HeadlessChrome Mozilla/5.0", pats)).toBe("bot");
    expect(classifyUserAgent("", pats)).toBe("unknown");
    expect(classifyUserAgent(null, pats)).toBe("unknown");
    expect(classifyUserAgent("cnote-app/1.2", pats)).toBe("app");
    expect(classifyUserAgent("SomethingElse", pats)).toBe("unknown");
  });
  const clean = { uaClass: "browser", self: false, duplicate: false, netBurst: false, velocity: false };
  it("verdict precedence", () => {
    expect(realtimeVerdict(clean)).toEqual({ validity: "valid" });
    expect(realtimeVerdict({ ...clean, self: true, uaClass: "bot" })).toEqual({ validity: "self_click", reason: "self" });
    expect(realtimeVerdict({ ...clean, uaClass: "bot" })).toEqual({ validity: "invalid", reason: "bot_ua" });
    expect(realtimeVerdict({ ...clean, uaClass: "unknown" })).toEqual({ validity: "invalid", reason: "bot_ua" });
    expect(realtimeVerdict({ ...clean, duplicate: true, netBurst: true })).toEqual({ validity: "invalid", reason: "duplicate" });
    expect(realtimeVerdict({ ...clean, netBurst: true })).toEqual({ validity: "pending", reason: "ip_burst" });
    expect(realtimeVerdict({ ...clean, velocity: true })).toEqual({ validity: "pending", reason: "click_velocity" });
  });
});

describe("IST time", () => {
  it("day boundaries are IST", () => {
    expect(istDate(new Date("2026-09-30T18:29:00Z"))).toBe("2026-09-30");
    expect(istDate(new Date("2026-09-30T18:31:00Z"))).toBe("2026-10-01");
    expect(istDayStart(new Date("2026-09-30T20:00:00Z")).toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(istDayFraction(new Date("2026-09-30T18:30:00Z"))).toBe(0);
    expect(istDayFraction(new Date("2026-10-01T06:30:00Z"))).toBeCloseTo(0.5);
    expect(hourKey(new Date("2026-09-30T05:59:59Z"))).toBe("2026-09-30T05");
  });
});
