import fc from "fast-check";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { classifyBot, classifyDevice, classifySource, pickTrafficParams, referrerHost } from "../src/classify";
import { classifyHit, dayKey, flushTraffic, isPageView, keys, normalizePath, recordHit, recordStorefrontEnquiry, totalsFromHash, visitorHash } from "../src/metering";
import { daysBetween, getMeteredRequests, getTrafficSummary, getTrafficSummaryForSeller } from "../src/queries";

describe("classifyBot table", () => {
  it.each([
    ["ChatGPT-User/1.0", "ChatGPT-User", "ai_crawler"], ["OAI-SearchBot/1.0", "OAI-SearchBot", "ai_crawler"],
    ["Claude-User/1.0", "Claude-User", "ai_crawler"], ["Claude-SearchBot", "Claude-SearchBot", "ai_crawler"], ["anthropic-ai", "anthropic-ai", "ai_crawler"],
    ["Perplexity-User/1.0", "Perplexity-User", "ai_crawler"], ["Applebot-Extended", "Applebot-Extended", "ai_crawler"],
    ["meta-externalagent/1.1", "Meta-ExternalAgent", "ai_crawler"], ["meta-externalfetcher/1.1", "Meta-ExternalAgent", "ai_crawler"],
    ["Bytespider; spider-feedback@bytedance.com", "Bytespider", "ai_crawler"], ["CCBot/2.0", "CCBot", "ai_crawler"],
    ["Amazonbot/0.1", "Amazonbot", "ai_crawler"], ["cohere-ai", "cohere-ai", "ai_crawler"], ["DuckAssistBot/1.2", "DuckAssistBot", "ai_crawler"],
    ["MistralAI-User/1.0", "MistralAI-User", "ai_crawler"], ["YouBot", "YouBot", "ai_crawler"], ["Diffbot/0.1", "Diffbot", "ai_crawler"],
    ["Google-CloudVertexBot", "Google-CloudVertexBot", "ai_crawler"], ["ImagesiftBot", "ImagesiftBot", "ai_crawler"], ["Timpibot/0.9", "Timpibot", "ai_crawler"],
    ["AdsBot-Google (+http://www.google.com/adsbot.html)", "AdsBot-Google", "search_crawler"], ["Storebot-Google/1.0", "Googlebot", "search_crawler"],
    ["Google-InspectionTool/1.0", "Googlebot", "search_crawler"], ["Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1)", "DuckDuckBot", "search_crawler"],
    ["Mozilla/5.0 (compatible; YandexBot/3.0)", "YandexBot", "search_crawler"], ["Mozilla/5.0 (compatible; Baiduspider/2.0)", "Baiduspider", "search_crawler"],
    ["Mozilla/5.0 (Applebot/0.1)", "Applebot", "search_crawler"], ["PetalBot", "PetalBot", "search_crawler"], ["BingPreview/1.0b", "Bingbot", "search_crawler"],
    ["FacebookBot/1.0", "FacebookBot", "social_preview"], ["Twitterbot/1.0", "Twitterbot", "social_preview"], ["LinkedInBot/1.0", "LinkedInBot", "social_preview"],
    ["Slackbot-LinkExpanding 1.0", "Slackbot", "social_preview"], ["TelegramBot", "TelegramBot", "social_preview"], ["TelegramBot (like TwitterBot)", "Twitterbot", "social_preview"] /* known gap: first-match ordering */, ["Discordbot/2.0", "Discordbot", "social_preview"],
    ["Pinterest/0.2 (+http://www.pinterest.com/bot.html)", "Pinterestbot", "social_preview"],
    ["SemrushBot/7", "SemrushBot", "seo_tool"], ["MJ12bot/v1.4.8", "MJ12bot", "seo_tool"], ["DotBot/1.2", "DotBot", "seo_tool"], ["Screaming Frog SEO Spider/19", "ScreamingFrog", "seo_tool"],
    ["Mozilla/5.0+(compatible; UptimeRobot/2.0)", "UptimeMonitor", "monitor"], ["Pingdom.com_bot_version_1.4", "UptimeMonitor", "monitor"],
    ["Mozilla/5.0 HeadlessChrome/120", "HeadlessBrowser", "other"], ["Mozilla/5.0 Playwright", "HeadlessBrowser", "other"],
    ["python-requests/2.31", "HTTP-client", "other"], ["Go-http-client/2.0", "HTTP-client", "other"], ["Wget/1.21", "HTTP-client", "other"],
    ["PostmanRuntime/7.36", "HTTP-client", "other"], ["okhttp/4.12", "HTTP-client", "other"], ["Scrapy/2.11", "HTTP-client", "other"],
    ["Mozilla/5.0 generic web scraper", "OtherBot", "other"], ["LinkPreview service", "OtherBot", "other"], ["   ", "Unknown", "other"],
  ])("%s", (ua, name, category) => expect(classifyBot(ua)).toEqual({ name, category }));
  it("null/undefined UA is a bot", () => {
    expect(classifyBot(null)?.name).toBe("Unknown");
    expect(classifyBot(undefined)?.name).toBe("Unknown");
  });
  it("browser lookalikes are humans", () => {
    for (const ua of [
      "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Edg/120.0.0.0",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120 Mobile/15E148 Safari/604.1",
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115 Mobile Safari/537.36",
    ]) expect(classifyBot(ua)).toBeNull();
  });
  it("property: never throws, and any UA containing a known bot token is a bot", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => { classifyBot(s); classifyDevice(s); }));
    fc.assert(fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => { expect(classifyBot(`${a} GPTBot/1 ${b}`)).not.toBeNull(); }));
  });
});

describe("classifyDevice extra", () => {
  it.each([
    ["Mozilla/5.0 (Linux; U; Android 4.0; Kindle Fire) Silk/3.0", "tablet"], ["PlayBook", "tablet"], ["Mozilla/5.0 (Windows Phone 10.0)", "mobile"],
    ["Opera/9.80 Opera Mini/7", "mobile"], ["BlackBerry9700", "mobile"], ["iPod touch", "mobile"], ["", "desktop"], [undefined, "desktop"],
  ])("%s", (ua, d) => expect(classifyDevice(ua as string | undefined)).toBe(d));
});

describe("classifySource table", () => {
  const src = (i: Parameters<typeof classifySource>[0]) => { const r = classifySource(i); return r.internal ? "internal" : `${r.source}/${r.label}`; };
  it.each([
    // AI assistants win over search even under google.com
    ["https://chatgpt.com/", "ai_assistant/chatgpt"], ["https://chat.openai.com/c/1", "ai_assistant/chatgpt"], ["https://www.perplexity.ai/search", "ai_assistant/perplexity"],
    ["https://gemini.google.com/app", "ai_assistant/gemini"], ["https://bard.google.com/", "ai_assistant/gemini"], ["https://claude.ai/chat", "ai_assistant/claude"],
    ["https://copilot.microsoft.com/", "ai_assistant/copilot"], ["https://grok.com/", "ai_assistant/grok"], ["https://chat.deepseek.com/", "ai_assistant/deepseek"],
    ["https://meta.ai/", "ai_assistant/meta-ai"], ["https://you.com/search", "ai_assistant/you.com"], ["https://www.phind.com/", "ai_assistant/phind"],
    ["https://poe.com/", "ai_assistant/poe"], ["https://chat.mistral.ai/", "ai_assistant/le-chat"],
    ["https://mail.google.com/mail", "email/gmail"], ["https://outlook.live.com/", "email/outlook"], ["https://mail.yahoo.com/", "email/yahoo-mail"],
    ["https://www.google.com/", "organic_search/google"], ["https://www.google.co.in/", "organic_search/google"], ["https://google.com.au/", "organic_search/google"],
    ["https://duckduckgo.com/", "organic_search/duckduckgo"], ["https://search.yahoo.com/", "organic_search/yahoo"], ["https://yandex.ru/", "organic_search/yandex"],
    ["https://www.baidu.com/", "organic_search/baidu"], ["https://www.ecosia.org/", "organic_search/ecosia"], ["https://search.brave.com/", "organic_search/brave"],
    ["https://m.facebook.com/", "social/facebook"], ["https://l.facebook.com/l.php", "social/facebook"], ["https://lnkd.in/x", "social/linkedin"], ["https://wa.me/1", "social/whatsapp"],
    ["https://t.co/x", "social/x"], ["https://youtu.be/x", "social/youtube"], ["https://www.reddit.com/", "social/reddit"], ["https://t.me/x", "social/telegram"],
    ["https://www.sharechat.com/", "social/sharechat"], ["https://www.tiktok.com/", "social/tiktok"],
    ["https://blog.example.org/post", "referral/blog.example.org"], ["https://notgoogle.com/", "referral/notgoogle.com"], ["https://google.com.evil.io/", "referral/google.com.evil.io"],
    ["not a url", "direct/direct"], ["", "direct/direct"],
    ["android-app://com.whatsapp/", "social/whatsapp"], ["android-app://com.google.android.gm", "email/gmail"], ["android-app://com.google.android.googlequicksearchbox/", "organic_search/google"],
    ["android-app://com.unknown.app/x", "referral/com.unknown.app"], ["android-app://", "referral/app"],
  ])("referrer %s -> %s", (referrer, expected) => expect(src({ referrer })).toBe(expected));

  it.each([
    [{ utm_medium: "cpc", utm_source: "google" }, "paid/google"], [{ utm_medium: "PPC" }, "paid/paid"], [{ gclid: "x" }, "paid/paid"], [{ msclkid: "x" }, "paid/paid"],
    [{ ttclid: "x", utm_source: "tiktok" }, "paid/tiktok"], [{ utm_medium: "paid-social" }, "paid/paid"], [{ utm_medium: "retargeting" }, "paid/paid"],
    [{ utm_medium: "email" }, "email/email"], [{ utm_medium: "newsletter", utm_source: "weekly" }, "email/weekly"], [{ utm_source: "email" }, "email/email"], [{ utm_medium: "edm" }, "email/email"],
    [{ utm_source: "chatgpt.com" }, "ai_assistant/chatgpt"], [{ utm_source: "chatgpt" }, "ai_assistant/chatgpt"], [{ utm_source: "perplexity" }, "ai_assistant/perplexity"],
    [{ utm_medium: "social" }, "social/social"], [{ utm_medium: "social", utm_source: "insider" }, "social/insider"], [{ utm_medium: "organic" }, "organic_search/search"],
    [{ fbclid: "x" }, "social/facebook"], [{ utm_source: "partner" }, "referral/partner"], [{ utm_source: "facebook" }, "social/facebook"],
  ] as [TrafficParamsLike, string][])("params %j -> %s", (params, expected) => expect(src({ params })).toBe(expected));

  it("paid beats referrer; fbclid alone is not paid; fbclid with paid medium is", () => {
    expect(src({ referrer: "https://www.google.com/", params: { gclid: "1" } })).toBe("paid/google.com");
    expect(src({ referrer: "https://www.facebook.com/", params: { fbclid: "1" } })).toBe("social/facebook");
    expect(src({ referrer: "https://www.facebook.com/", params: { fbclid: "1", utm_medium: "cpc" } })).toMatch(/^paid/);
    expect(src({ referrer: "https://unknown.example/", params: { fbclid: "1" } })).toBe("social/facebook");
  });
  it("internal navigation (own host / subdomain, www-insensitive) yields no source", () => {
    expect(src({ referrer: "https://www.acme.com/a", ownHosts: ["acme.com"] })).toBe("internal");
    expect(src({ referrer: "https://shop.acme.com/", ownHosts: ["WWW.Acme.com"] })).toBe("internal");
    expect(src({ referrer: "https://evilacme.com/", ownHosts: ["acme.com"] })).toBe("referral/evilacme.com");
    expect(src({ referrer: "https://www.acme.com/", params: { utm_medium: "cpc" }, ownHosts: ["acme.com"] })).toBe("internal");
  });
  it("referrerHost / pickTrafficParams", () => {
    expect(referrerHost("https://WWW.Foo.com/x?y")).toBe("foo.com");
    expect(referrerHost("nope")).toBeNull();
    expect(referrerHost(null)).toBeNull();
    const p = pickTrafficParams(new URLSearchParams(`utm_source=${"a".repeat(200)}&gclid=1&other=2&utm_medium=`));
    expect(p.utm_source).toHaveLength(80);
    expect(p).toEqual({ utm_source: "a".repeat(80), gclid: "1" });
  });
  it("property: never throws; label always non-empty", () => {
    fc.assert(fc.property(fc.option(fc.webUrl(), { nil: undefined }), fc.string(), fc.string(), (referrer, m, s) => {
      const r = classifySource({ referrer, params: { utm_medium: m, utm_source: s } });
      if (!r.internal) expect(r.label).toBeTruthy();
    }));
  });
});
type TrafficParamsLike = Parameters<typeof classifySource>[0]["params"];

describe("metering pure helpers", () => {
  it("dayKey is the IST day (boundary at 18:30 UTC)", () => {
    expect(dayKey(new Date("2026-03-01T18:29:59Z"))).toBe("2026-03-01");
    expect(dayKey(new Date("2026-03-01T18:30:00Z"))).toBe("2026-03-02");
    expect(dayKey(new Date("2026-12-31T20:00:00Z"))).toBe("2027-01-01");
  });
  it("normalizePath: property idempotent, starts with /, no query, clipped", () => {
    fc.assert(fc.property(fc.string(), (s) => {
      const p = normalizePath(s);
      expect(p.startsWith("/")).toBe(true);
      expect(p).not.toMatch(/[?#]/);
      expect(p.length).toBeLessThanOrEqual(120);
      expect(normalizePath(p)).toBe(p);
    }));
    expect(normalizePath("a//")).toBe("/a");
    expect(normalizePath("/?x")).toBe("/");
  });
  it.each([["/", true], ["/products/x", true], ["/_next/static/x.js", false], ["/.well-known/cnote-domain-check", false], ["/api/x", false], ["/logo.PNG", false], ["/sitemap.xml", false], ["/a.html", true], ["/robots.txt", false]])("isPageView %s", (p, e) => expect(isPageView(p)).toBe(e));
  it("assets/bots never count visitors; humans always do; every request counts req + hk", () => {
    const UA = "Mozilla/5.0 (Macintosh) Chrome/120 Safari/537.36";
    fc.assert(fc.property(fc.string({ maxLength: 30 }), fc.boolean(), (path, bot) => {
      const c = classifyHit({ host: "a.com", path, hostKind: "custom", userAgent: bot ? "Googlebot" : UA });
      const f = Object.fromEntries(c.fields);
      expect(f.req).toBe(1);
      expect(f["hk:custom"]).toBe(1);
      if (bot) expect(c.countsVisitor).toBe(false);
      if (c.countsVisitor) expect(f.pv).toBe(1);
    }));
  });
  it("visitorHash: 32 hex, depends on all inputs", () => {
    const h = visitorHash("s", "1.1.1.1", "ua");
    expect(h).toMatch(/^[0-9a-f]{32}$/);
    expect(visitorHash("s", null, undefined)).toBe(visitorHash("s", "", ""));
    expect(new Set([visitorHash("s", "1", "a"), visitorHash("s", "2", "a"), visitorHash("s", "1", "b"), visitorHash("t", "1", "a")]).size).toBe(4);
  });
  it("totalsFromHash ignores unknown fields and non-numeric values", () => {
    const t = totalsFromHash({ req: "x", junk: "5", "page:/": "2" }, 0);
    expect(t.requests).toBe(0);
    expect(t.byPage).toEqual({ "/": 2 });
  });
});

const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const slug = `tx-${run}`;
const days = ["2098-05-01", "2098-05-02", "2098-05-03"];
let biz: string;
let sfId: string;
const HUMAN = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36";

beforeAll(async () => {
  biz = (await prisma.business.create({ data: { name: `tx-${run}` } })).id;
  sfId = (await prisma.storefront.create({ data: { sellerBusinessId: biz, slug } })).id;
});
afterAll(async () => {
  for (const d of days) await redis.del(keys.hash(d, slug), keys.hll(d, slug), keys.dirty(d), keys.flushing(d), keys.salt(d), keys.hash(d, `ghost-${run}`), keys.hll(d, `ghost-${run}`));
  await prisma.storefrontTrafficDaily.deleteMany({ where: { storefrontId: sfId } });
  await prisma.storefront.delete({ where: { id: sfId } });
  await prisma.business.delete({ where: { id: biz } });
});

describe("enquiries, flush and summaries", () => {
  it("recordStorefrontEnquiry counts conversions and marks the storefront dirty", async () => {
    const d = dayKey();
    try {
      await recordStorefrontEnquiry(slug, d);
      await recordStorefrontEnquiry(slug, d);
      expect(await redis.hget(keys.hash(d, slug), "enq")).toBe("2");
      expect(await redis.sismember(keys.dirty(d), slug)).toBe(1);
      const first = await flushTraffic();
      expect(first.flushed).toBeGreaterThanOrEqual(1);
      const row = await prisma.storefrontTrafficDaily.findFirstOrThrow({ where: { storefrontId: sfId, day: new Date(`${d}T00:00:00.000Z`) } });
      expect(row.enquiries).toBe(2);
      // replay after more activity converges to the absolute total, never double counts
      await recordStorefrontEnquiry(slug, d);
      await flushTraffic();
      await flushTraffic();
      const again = await prisma.storefrontTrafficDaily.findFirstOrThrow({ where: { storefrontId: sfId, day: new Date(`${d}T00:00:00.000Z`) } });
      expect(again.enquiries).toBe(3);
    } finally {
      await redis.del(keys.hash(d, slug), keys.hll(d, slug), keys.dirty(d), keys.flushing(d));
      await prisma.storefrontTrafficDaily.deleteMany({ where: { storefrontId: sfId } });
    }
  });

  it("flush skips slugs with no storefront (and drops them from the batch)", async () => {
    const d = dayKey();
    const ghost = `ghost-${run}`;
    try {
      await recordHit({ host: "x.com", path: "/", storefrontSlug: ghost, hostKind: "path", userAgent: HUMAN, ip: "1.1.1.1" });
      const r = await flushTraffic();
      expect(r.skipped).toBeGreaterThanOrEqual(1);
      expect(await redis.sismember(keys.flushing(d), ghost)).toBe(0);
    } finally {
      await redis.del(keys.hash(d, ghost), keys.hll(d, ghost));
    }
  });

  it("a failing upsert leaves the slug in the flushing set for retry", async () => {
    const d = dayKey();
    const spy = vi.spyOn(prisma.storefrontTrafficDaily, "upsert").mockRejectedValueOnce(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await recordHit({ host: "x.com", path: "/", storefrontSlug: slug, hostKind: "path", userAgent: HUMAN, ip: "2.2.2.2" });
      const r1 = await flushTraffic();
      expect(r1.flushed).toBe(0);
      expect(await redis.sismember(keys.flushing(d), slug)).toBe(1);
      const r2 = await flushTraffic();
      expect(r2.flushed).toBeGreaterThanOrEqual(1);
      expect(await redis.sismember(keys.flushing(d), slug)).toBe(0);
    } finally {
      spy.mockRestore();
      err.mockRestore();
      await redis.del(keys.hash(d, slug), keys.hll(d, slug), keys.dirty(d), keys.flushing(d));
      await prisma.storefrontTrafficDaily.deleteMany({ where: { storefrontId: sfId } });
    }
  });

  it("HLL unique counting is approximately right and repeat hits do not inflate it", async () => {
    const d = days[0]!;
    for (let i = 0; i < 300; i++) await recordHit({ host: "x.com", path: "/", storefrontSlug: slug, hostKind: "path", userAgent: HUMAN, ip: `10.1.${Math.floor(i / 250)}.${i % 250}` }, d);
    for (let i = 0; i < 50; i++) await recordHit({ host: "x.com", path: "/", storefrontSlug: slug, hostKind: "path", userAgent: HUMAN, ip: "10.1.0.1" }, d);
    const u = await redis.pfcount(keys.hll(d, slug));
    expect(u).toBeGreaterThan(285);
    expect(u).toBeLessThan(315);
    expect(Number(await redis.hget(keys.hash(d, slug), "pv"))).toBe(350);
  });

  it("summaries: zero-filled series, sums, ranking with (other) fold, seller lookup, metered requests", async () => {
    const day = (i: number) => new Date(`${days[i]}T00:00:00.000Z`);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${String(i).padStart(2, "0")}`, 20 - i]));
    await prisma.storefrontTrafficDaily.createMany({ data: [
      { storefrontId: sfId, day: day(0), requests: 100, pageviews: 60, uniqueVisitors: 30, enquiries: 2, bySource: { direct: 5, organic_search: 9 }, byReferrer: many, byPage: { "/": 3 }, byDevice: { mobile: 4 }, botHits: { GPTBot: 10 }, byHostKind: { custom: 100 } },
      { storefrontId: sfId, day: day(2), requests: 50, pageviews: 20, uniqueVisitors: 10, enquiries: 1, bySource: { direct: 1 }, byReferrer: {}, byPage: { "/": 2, "/x": 1 }, byDevice: {}, botHits: { GPTBot: 5, CCBot: 1 }, byHostKind: {} },
    ] });
    const s = await getTrafficSummary(sfId, { from: days[0], to: days[2] });
    expect(s.series.map((p) => [p.day, p.requests])).toEqual([[days[0], 100], [days[1], 0], [days[2], 50]]);
    expect(s.totals).toEqual({ requests: 150, pageviews: 80, uniqueVisitors: 40, botHits: 16, humanRequests: 134, enquiries: 3 });
    expect(s.bySource[0]).toEqual({ key: "organic_search", count: 9 });
    expect(s.byPage).toEqual([{ key: "/", count: 5 }, { key: "/x", count: 1 }]);
    expect(s.bots).toEqual([{ key: "GPTBot", count: 15 }, { key: "CCBot", count: 1 }]);
    expect(s.byReferrer).toHaveLength(16);
    expect(s.byReferrer[15]).toEqual({ key: "(other)", count: 5 + 4 + 3 + 2 + 1 });
    expect((await getTrafficSummaryForSeller(biz, { from: days[0], to: days[2] }))?.totals.requests).toBe(150);
    expect(await getTrafficSummaryForSeller("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getMeteredRequests(sfId, days[0]!, days[1]!)).toBe(100);
    expect(await getMeteredRequests(sfId, days[0]!, days[2]!)).toBe(150);
    expect(await getMeteredRequests(sfId, "2099-01-01", "2099-01-02")).toBe(0);
    const dflt = await getTrafficSummary(sfId);
    expect(dflt.series).toHaveLength(30);
    expect((await getTrafficSummary(sfId, { days: 7 })).series).toHaveLength(7);
  });
  it("daysBetween is inclusive, ordered, and capped", () => {
    expect(daysBetween("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(daysBetween("2026-03-02", "2026-03-01")).toEqual([]);
    expect(daysBetween("2000-01-01", "2026-01-01")).toHaveLength(400);
  });
});
