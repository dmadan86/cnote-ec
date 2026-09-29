// Pure classifiers used by metering: bot vs human, traffic source, device. No I/O.

export type TrafficSource = "direct" | "organic_search" | "social" | "ai_assistant" | "paid" | "email" | "referral";
export type Device = "mobile" | "tablet" | "desktop";

// ---- bots ------------------------------------------------------------------------------------

export type BotCategory = "ai_crawler" | "search_crawler" | "social_preview" | "seo_tool" | "monitor" | "other";
export interface BotMatch {
  name: string;
  category: BotCategory;
}

/** Order matters: first match wins (specific before generic). */
const BOTS: [RegExp, string, BotCategory][] = [
  [/GPTBot/i, "GPTBot", "ai_crawler"],
  [/ChatGPT-User/i, "ChatGPT-User", "ai_crawler"],
  [/OAI-SearchBot/i, "OAI-SearchBot", "ai_crawler"],
  [/ClaudeBot/i, "ClaudeBot", "ai_crawler"],
  [/Claude-User/i, "Claude-User", "ai_crawler"],
  [/Claude-SearchBot/i, "Claude-SearchBot", "ai_crawler"],
  [/anthropic-ai/i, "anthropic-ai", "ai_crawler"],
  [/PerplexityBot/i, "PerplexityBot", "ai_crawler"],
  [/Perplexity-User/i, "Perplexity-User", "ai_crawler"],
  [/Google-Extended/i, "Google-Extended", "ai_crawler"],
  [/Google-CloudVertexBot/i, "Google-CloudVertexBot", "ai_crawler"],
  [/Applebot-Extended/i, "Applebot-Extended", "ai_crawler"],
  [/meta-externalagent|meta-externalfetcher/i, "Meta-ExternalAgent", "ai_crawler"],
  [/Bytespider/i, "Bytespider", "ai_crawler"],
  [/CCBot/i, "CCBot", "ai_crawler"],
  [/Amazonbot/i, "Amazonbot", "ai_crawler"],
  [/cohere-ai/i, "cohere-ai", "ai_crawler"],
  [/DuckAssistBot/i, "DuckAssistBot", "ai_crawler"],
  [/MistralAI-User/i, "MistralAI-User", "ai_crawler"],
  [/YouBot/i, "YouBot", "ai_crawler"],
  [/Diffbot/i, "Diffbot", "ai_crawler"],
  [/ImagesiftBot/i, "ImagesiftBot", "ai_crawler"],
  [/Timpibot/i, "Timpibot", "ai_crawler"],
  [/AdsBot-Google/i, "AdsBot-Google", "search_crawler"],
  [/Googlebot|Google-InspectionTool|GoogleOther|Storebot-Google|Mediapartners-Google/i, "Googlebot", "search_crawler"],
  [/bingbot|BingPreview|msnbot/i, "Bingbot", "search_crawler"],
  [/DuckDuckBot/i, "DuckDuckBot", "search_crawler"],
  [/YandexBot|YandexImages/i, "YandexBot", "search_crawler"],
  [/Baiduspider/i, "Baiduspider", "search_crawler"],
  [/Applebot/i, "Applebot", "search_crawler"],
  [/PetalBot/i, "PetalBot", "search_crawler"],
  [/facebookexternalhit|facebookcatalog/i, "facebookexternalhit", "social_preview"],
  [/FacebookBot/i, "FacebookBot", "social_preview"],
  [/Twitterbot/i, "Twitterbot", "social_preview"],
  [/LinkedInBot/i, "LinkedInBot", "social_preview"],
  [/^WhatsApp\//i, "WhatsApp", "social_preview"],
  [/Slackbot/i, "Slackbot", "social_preview"],
  [/TelegramBot/i, "TelegramBot", "social_preview"],
  [/Discordbot/i, "Discordbot", "social_preview"],
  [/Pinterestbot|Pinterest\//i, "Pinterestbot", "social_preview"],
  [/SemrushBot/i, "SemrushBot", "seo_tool"],
  [/AhrefsBot/i, "AhrefsBot", "seo_tool"],
  [/MJ12bot/i, "MJ12bot", "seo_tool"],
  [/DotBot/i, "DotBot", "seo_tool"],
  [/Screaming Frog/i, "ScreamingFrog", "seo_tool"],
  [/UptimeRobot|Pingdom|Uptime-Kuma|StatusCake|Site24x7|BetterUptime/i, "UptimeMonitor", "monitor"],
  [/HeadlessChrome|PhantomJS|Puppeteer|Playwright/i, "HeadlessBrowser", "other"],
  [/^(curl|Wget|python-requests|python-urllib|Go-http-client|axios|node-fetch|okhttp|Java|libwww-perl|Apache-HttpClient|PostmanRuntime|Scrapy)/i, "HTTP-client", "other"],
  [/bot\b|crawl|spider|slurp|scrape|fetch|monitor|preview/i, "OtherBot", "other"],
];

/** Null for humans. An empty user agent is treated as a bot ("Unknown"). */
export function classifyBot(userAgent: string | null | undefined): BotMatch | null {
  const ua = (userAgent ?? "").trim();
  if (!ua) return { name: "Unknown", category: "other" };
  for (const [re, name, category] of BOTS) if (re.test(ua)) return { name, category };
  return null;
}

// ---- device ----------------------------------------------------------------------------------

export function classifyDevice(userAgent: string | null | undefined): Device {
  const ua = userAgent ?? "";
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return "mobile";
  return "desktop";
}

// ---- source ----------------------------------------------------------------------------------

export interface TrafficParams {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  /** click identifiers present on the landing URL */
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  msclkid?: string;
  ttclid?: string;
  twclid?: string;
  fbclid?: string;
}

const PARAM_KEYS: (keyof TrafficParams)[] = ["utm_source", "utm_medium", "utm_campaign", "gclid", "gbraid", "wbraid", "msclkid", "ttclid", "twclid", "fbclid"];

/** Pick the tracking params we understand out of a URLSearchParams (values clipped, never the whole query string). */
export function pickTrafficParams(sp: URLSearchParams): TrafficParams {
  const out: TrafficParams = {};
  for (const k of PARAM_KEYS) {
    const v = sp.get(k);
    if (v) out[k] = v.slice(0, 80);
  }
  return out;
}

export interface SourceResult {
  source: TrafficSource;
  /** finer label: "google", "chatgpt", "facebook", or the referring host */
  label: string;
}

const hostIs = (host: string, d: string) => host === d || host.endsWith(`.${d}`);
type Rule = { test: (h: string) => boolean; source: TrafficSource; label: string };
const r = (label: string, source: TrafficSource, ...domains: string[]): Rule => ({ label, source, test: (h) => domains.some((d) => hostIs(h, d)) });

/** AI assistants are checked before search so gemini.google.com is not "google". */
const RULES: Rule[] = [
  r("chatgpt", "ai_assistant", "chatgpt.com", "chat.openai.com", "openai.com"),
  r("perplexity", "ai_assistant", "perplexity.ai"),
  r("gemini", "ai_assistant", "gemini.google.com", "bard.google.com", "aistudio.google.com"),
  r("claude", "ai_assistant", "claude.ai"),
  r("copilot", "ai_assistant", "copilot.microsoft.com", "copilot.com"),
  r("grok", "ai_assistant", "grok.com"),
  r("deepseek", "ai_assistant", "deepseek.com"),
  r("meta-ai", "ai_assistant", "meta.ai"),
  r("you.com", "ai_assistant", "you.com"),
  r("phind", "ai_assistant", "phind.com"),
  r("poe", "ai_assistant", "poe.com"),
  r("le-chat", "ai_assistant", "chat.mistral.ai"),
  r("gmail", "email", "mail.google.com"),
  r("outlook", "email", "outlook.live.com", "outlook.office.com", "outlook.office365.com"),
  r("yahoo-mail", "email", "mail.yahoo.com"),
  r("google", "organic_search", "google.com"),
  { test: (h) => /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h), source: "organic_search", label: "google" },
  r("bing", "organic_search", "bing.com"),
  r("duckduckgo", "organic_search", "duckduckgo.com"),
  r("yahoo", "organic_search", "search.yahoo.com", "yahoo.com"),
  r("yandex", "organic_search", "yandex.com", "yandex.ru"),
  r("baidu", "organic_search", "baidu.com"),
  r("ecosia", "organic_search", "ecosia.org"),
  r("brave", "organic_search", "search.brave.com"),
  r("startpage", "organic_search", "startpage.com"),
  r("qwant", "organic_search", "qwant.com"),
  r("ask", "organic_search", "ask.com"),
  r("facebook", "social", "facebook.com", "fb.com", "fb.me", "fb.watch"),
  r("instagram", "social", "instagram.com"),
  r("linkedin", "social", "linkedin.com", "lnkd.in"),
  r("whatsapp", "social", "whatsapp.com", "wa.me"),
  r("x", "social", "twitter.com", "x.com", "t.co"),
  r("youtube", "social", "youtube.com", "youtu.be"),
  r("pinterest", "social", "pinterest.com", "pin.it"),
  r("reddit", "social", "reddit.com"),
  r("telegram", "social", "t.me", "telegram.org"),
  r("threads", "social", "threads.net"),
  r("snapchat", "social", "snapchat.com"),
  r("tiktok", "social", "tiktok.com"),
  r("quora", "social", "quora.com"),
  r("sharechat", "social", "sharechat.com"),
];
const rulesFor = (host: string) => RULES.find((x) => x.test(host));

/** Android app referrers (android-app://<package>) */
const ANDROID_APPS: Record<string, Rule["label"] & string> = {
  "com.whatsapp": "whatsapp",
  "com.facebook.katana": "facebook",
  "com.facebook.lite": "facebook",
  "com.instagram.android": "instagram",
  "com.linkedin.android": "linkedin",
  "com.twitter.android": "x",
  "org.telegram.messenger": "telegram",
  "com.google.android.googlequicksearchbox": "google",
  "com.google.android.gm": "gmail",
};

const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid[-_ ]?social|paidsocial|cpm|cpv|display|banner|retargeting|remarketing|sponsored|ads?)$/i;
const EMAIL_MEDIUM = /^(e-?mail|newsletter|edm)$/i;
const SOCIAL_MEDIUM = /^(social|social-network|social-media|sm|smm)$/i;
const SEARCH_MEDIUM = /^(organic|seo)$/i;
const CLICK_IDS: (keyof TrafficParams)[] = ["gclid", "gbraid", "wbraid", "msclkid", "ttclid", "twclid"];

/** Strip scheme/path/www and lowercase; null when it is not a usable host. */
export function referrerHost(referrer: string | null | undefined): string | null {
  if (!referrer) return null;
  try {
    const u = new URL(referrer);
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    return h || null;
  } catch {
    return null;
  }
}

/**
 * Traffic source for one human page load. Precedence: paid click ids / utm_medium, then utm_source, then the referrer.
 * `internal` is true when the referrer is one of our own hosts (in-site navigation): callers must not count a source.
 * fbclid alone is NOT paid (Facebook appends it to organic outbound links); it is social unless utm_medium says paid.
 */
export function classifySource(input: { referrer?: string | null; params?: TrafficParams; ownHosts?: string[] }): (SourceResult & { internal: false }) | { internal: true } {
  const p = input.params ?? {};
  const own = (input.ownHosts ?? []).map((h) => h.toLowerCase().replace(/^www\./, ""));
  const refHost = referrerHost(input.referrer);
  if (refHost && own.some((o) => refHost === o || refHost.endsWith(`.${o}`))) return { internal: true };

  const medium = p.utm_medium?.trim() ?? "";
  const src = p.utm_source?.trim().toLowerCase() ?? "";
  const label = (fallback: string) => (src ? src.replace(/^www\./, "") : fallback);

  if (CLICK_IDS.some((k) => p[k]) || PAID_MEDIUM.test(medium)) {
    return { internal: false, source: "paid", label: label(refHost ?? "paid") };
  }
  if (EMAIL_MEDIUM.test(medium) || src === "email" || src === "newsletter") return { internal: false, source: "email", label: label("email") };
  // utm_source naming a known site (chatgpt.com adds utm_source=chatgpt.com to links it opens)
  if (src) {
    const bySrc = rulesFor(src.includes(".") ? src : `${src}.com`) ?? RULES.find((x) => x.label === src);
    if (bySrc) return { internal: false, source: bySrc.source, label: bySrc.label };
  }
  if (SOCIAL_MEDIUM.test(medium)) return { internal: false, source: "social", label: label(refHost ?? "social") };
  if (SEARCH_MEDIUM.test(medium)) return { internal: false, source: "organic_search", label: label(refHost ?? "search") };

  if (input.referrer?.startsWith("android-app://")) {
    const pkg = input.referrer.slice("android-app://".length).split("/")[0] ?? "";
    const l = ANDROID_APPS[pkg];
    const hit = l ? RULES.find((x) => x.label === l) : undefined;
    if (hit) return { internal: false, source: hit.source, label: hit.label };
    return { internal: false, source: "referral", label: pkg || "app" };
  }
  if (refHost) {
    const hit = rulesFor(refHost);
    if (hit) return { internal: false, source: hit.source, label: hit.label };
    if (p.fbclid) return { internal: false, source: "social", label: "facebook" };
    return { internal: false, source: "referral", label: refHost };
  }
  if (p.fbclid) return { internal: false, source: "social", label: "facebook" };
  if (src) return { internal: false, source: "referral", label: src };
  return { internal: false, source: "direct", label: "direct" };
}
