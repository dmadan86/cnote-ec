import type { MetadataRoute } from "next";
import { PWA_BACKGROUND_COLOR, PWA_ICONS, PWA_THEME_COLOR } from "@/features/pwa/manifest-data";
import { SITE_NAME, SITE_TAGLINE } from "@/features/shell/site";

// Web app manifest (ADR-004: low-bandwidth, installable). Served at /manifest.webmanifest.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME}: ${SITE_TAGLINE}`,
    short_name: SITE_NAME,
    description: SITE_TAGLINE,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    lang: "en-IN",
    theme_color: PWA_THEME_COLOR,
    background_color: PWA_BACKGROUND_COLOR,
    icons: PWA_ICONS.filter((i) => i.file !== "apple-touch-icon.png").map((i) => ({ src: `/icons/${i.file}`, sizes: `${i.size}x${i.size}`, type: "image/png", purpose: i.maskable ? "maskable" : "any" })),
  };
}
