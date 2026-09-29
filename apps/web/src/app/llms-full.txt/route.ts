import { buildLlmsFullTxt } from "@/features/seo/llms";

// Plain-text description of the site for LLM crawlers and agents (llmstxt.org). Static, refreshed hourly.
export const revalidate = 3600;

export async function GET() {
  return new Response(await buildLlmsFullTxt(), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
