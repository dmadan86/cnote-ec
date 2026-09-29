import { ImageResponse } from "next/og";
import { SITE_NAME, SITE_TAGLINE } from "@/features/shell/site";

export const alt = `${SITE_NAME}: ${SITE_TAGLINE}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "center", gap: 24, background: "linear-gradient(135deg,#f5f3ff,#ffffff)", padding: 80, fontFamily: "sans-serif" }}>
        <div style={{ fontSize: 40, fontWeight: 800, color: "#5b2fd6" }}>{SITE_NAME}</div>
        <div style={{ fontSize: 76, fontWeight: 800, color: "#111827", lineHeight: 1.05 }}>Everything your business needs in one place</div>
        <div style={{ fontSize: 34, color: "#596272" }}>{SITE_TAGLINE}</div>
      </div>
    ),
    { ...size },
  );
}
