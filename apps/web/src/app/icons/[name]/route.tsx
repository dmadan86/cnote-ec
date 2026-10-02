import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { PWA_ICONS } from "@/features/pwa/manifest-data";

// PWA / home-screen icons, drawn from the brand mark (packages/ui LogoMark) like the generated Open Graph card, so there
// are no binary assets to keep in sync. Prerendered at build: /icons/icon-192.png, icon-512.png, icon-maskable-512.png,
// apple-touch-icon.png. Maskable icons keep the mark inside the central 60% safe zone.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return PWA_ICONS.map((i) => ({ name: i.file }));
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const icon = PWA_ICONS.find((i) => i.file === name);
  if (!icon) notFound();
  const mark = Math.round(icon.size * (icon.maskable ? 0.56 : 0.66));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#5b2fd6" }}>
        <svg width={mark} height={mark} viewBox="0 0 32 32" fill="none">
          <path d="M16 2.5 27.5 9v14L16 29.5 4.5 23V9L16 2.5Z" fill="#ffffff" />
          <path d="M16 9.5 22 13v6.5L16 23l-6-3.5V13l6-3.5Z" stroke="#5b2fd6" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M10 13l6 3.5L22 13M16 16.5V23" stroke="#5b2fd6" strokeWidth="1.8" strokeLinejoin="round" />
        </svg>
      </div>
    ),
    { width: icon.size, height: icon.size, headers: { "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800" } },
  );
}
