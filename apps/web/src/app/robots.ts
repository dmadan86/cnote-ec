import type { MetadataRoute } from "next";
import { absoluteUrl, SITE_ORIGIN } from "@/lib/site-url";

// Private / transactional areas are never crawled. Free-text /search?q= results are NOT disallowed on purpose: they
// carry `noindex,follow` in their meta robots, which crawlers can only honour if they may fetch the page.
const PRIVATE = ["/account", "/buyer", "/rfq", "/conversations", "/wishlist", "/compare", "/onboarding", "/signin", "/signup", "/forgot-password", "/reset-password", "/preview", "/api/"];

// AI / LLM crawlers are welcome on the public catalogue (same private exclusions); /llms.txt describes the site for them.
const AI_BOTS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Applebot-Extended", "CCBot"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      { userAgent: AI_BOTS, allow: ["/", "/llms.txt", "/llms-full.txt"], disallow: PRIVATE },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
    host: SITE_ORIGIN,
  };
}
