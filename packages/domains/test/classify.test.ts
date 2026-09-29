import { describe, expect, it } from "vitest";
import { classifyBot, classifyDevice, classifySource, pickTrafficParams } from "../src/classify";

describe("classifyBot", () => {
  it.each([
    ["Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "GPTBot", "ai_crawler"],
    ["Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "ClaudeBot", "ai_crawler"],
    ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "PerplexityBot", "ai_crawler"],
    ["Mozilla/5.0 (compatible; Google-Extended)", "Google-Extended", "ai_crawler"],
    ["Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X) (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", "Googlebot", "search_crawler"],
    ["Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)", "Bingbot", "search_crawler"],
    ["facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)", "facebookexternalhit", "social_preview"],
    ["WhatsApp/2.23.20.0 A", "WhatsApp", "social_preview"],
    ["Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)", "AhrefsBot", "seo_tool"],
    ["curl/8.4.0", "HTTP-client", "other"],
    ["SomeUnknown Crawler 1.0", "OtherBot", "other"],
    ["", "Unknown", "other"],
  ])("%s", (ua, name, category) => {
    expect(classifyBot(ua)).toEqual({ name, category });
  });

  it.each([
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  ])("treats real browsers as human", (ua) => {
    expect(classifyBot(ua)).toBeNull();
  });
});

describe("classifyDevice", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148", "mobile"],
    ["Mozilla/5.0 (Linux; Android 13; SM-S918B) Chrome/120 Mobile Safari/537.36", "mobile"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15", "tablet"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X710) Chrome/120 Safari/537.36", "tablet"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36", "desktop"],
    [null, "desktop"],
  ])("%s -> %s", (ua, device) => {
    expect(classifyDevice(ua)).toBe(device);
  });
});

const own = ["acme.com"];
describe("classifySource", () => {
  const cases: [string, Parameters<typeof classifySource>[0], string, string?][] = [
    ["no referrer", {}, "direct", "direct"],
    ["google in", { referrer: "https://www.google.co.in/" }, "organic_search", "google"],
    ["google.com", { referrer: "https://www.google.com/" }, "organic_search", "google"],
    ["bing", { referrer: "https://www.bing.com/search?q=x" }, "organic_search", "bing"],
    ["duckduckgo", { referrer: "https://duckduckgo.com/" }, "organic_search", "duckduckgo"],
    ["android google app", { referrer: "android-app://com.google.android.googlequicksearchbox" }, "organic_search", "google"],
    ["facebook", { referrer: "https://l.facebook.com/l.php?u=x" }, "social", "facebook"],
    ["instagram", { referrer: "https://l.instagram.com/" }, "social", "instagram"],
    ["linkedin short", { referrer: "https://lnkd.in/abc" }, "social", "linkedin"],
    ["x / t.co", { referrer: "https://t.co/abc" }, "social", "x"],
    ["whatsapp android", { referrer: "android-app://com.whatsapp" }, "social", "whatsapp"],
    ["chatgpt", { referrer: "https://chatgpt.com/" }, "ai_assistant", "chatgpt"],
    ["chatgpt utm only", { params: { utm_source: "chatgpt.com" } }, "ai_assistant", "chatgpt"],
    ["perplexity", { referrer: "https://www.perplexity.ai/search/x" }, "ai_assistant", "perplexity"],
    ["gemini is not google search", { referrer: "https://gemini.google.com/app" }, "ai_assistant", "gemini"],
    ["claude", { referrer: "https://claude.ai/chat/1" }, "ai_assistant", "claude"],
    ["copilot", { referrer: "https://copilot.microsoft.com/" }, "ai_assistant", "copilot"],
    ["gclid is paid even with google referrer", { referrer: "https://www.google.com/", params: { gclid: "x" } }, "paid", undefined],
    ["msclkid paid", { params: { msclkid: "x" } }, "paid"],
    ["utm cpc", { params: { utm_medium: "cpc", utm_source: "google" } }, "paid", "google"],
    ["utm paid_social", { params: { utm_medium: "paid_social", utm_source: "facebook" } }, "paid"],
    ["fbclid alone is social", { params: { fbclid: "x" } }, "social", "facebook"],
    ["fbclid with cpc is paid", { params: { fbclid: "x", utm_medium: "cpc" } }, "paid"],
    ["email medium", { params: { utm_medium: "email", utm_source: "newsletter" } }, "email"],
    ["gmail referrer", { referrer: "https://mail.google.com/" }, "email", "gmail"],
    ["utm_source whatsapp", { params: { utm_source: "whatsapp" } }, "social", "whatsapp"],
    ["utm medium social", { params: { utm_medium: "social", utm_source: "somenet" } }, "social", "somenet"],
    ["other site is referral", { referrer: "https://www.blog.example.org/post" }, "referral", "blog.example.org"],
    ["garbage referrer is direct", { referrer: "not a url" }, "direct"],
  ];
  it.each(cases)("%s", (_n, input, source, label) => {
    const r = classifySource({ ...input, ownHosts: own });
    expect(r.internal).toBe(false);
    if (!r.internal) {
      expect(r.source).toBe(source);
      if (label) expect(r.label).toBe(label);
    }
  });

  it("flags own-site referrers as internal (no source counted)", () => {
    expect(classifySource({ referrer: "https://www.acme.com/products", ownHosts: own })).toEqual({ internal: true });
    expect(classifySource({ referrer: "https://shop.acme.com/", ownHosts: own })).toEqual({ internal: true });
  });

  it("pickTrafficParams keeps only known keys", () => {
    const p = pickTrafficParams(new URLSearchParams("utm_source=a&foo=b&gclid=1&utm_medium=cpc"));
    expect(p).toEqual({ utm_source: "a", gclid: "1", utm_medium: "cpc" });
  });
});
