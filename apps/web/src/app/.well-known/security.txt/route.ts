import { buildSecurityTxt } from "@/features/legal/security-txt";

// ISR: rendered from env at build and re-rendered hourly, so Expires (one year ahead) never lapses.
export const revalidate = 3600;

export function GET() {
  return new Response(buildSecurityTxt(), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600, s-maxage=3600" },
  });
}
