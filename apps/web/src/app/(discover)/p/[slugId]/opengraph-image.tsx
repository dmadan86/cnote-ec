import { ImageResponse } from "next/og";
import { parseProductParam } from "@/lib/paths";
import { loadListing, loadSeller } from "@/features/search/data";
import { SITE_NAME } from "@/features/shell/site";

// Dynamic 1200x630 social card per product (title, indicative price, supplier). Cached with the page (ISR).
export const alt = "Product on the marketplace";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 3600;

export default async function Image({ params }: { params: Promise<{ slugId: string }> }) {
  const { slugId } = await params;
  const parsed = parseProductParam(slugId);
  const listing = parsed ? await loadListing(parsed.id) : null;
  const seller = listing ? await loadSeller(listing.sellerBusinessId) : null;
  const title = listing?.title ?? SITE_NAME;
  const price = listing?.pricePaise != null ? `₹${(listing.pricePaise / 100).toLocaleString("en-IN")}${listing.priceUnit ? ` / ${listing.priceUnit}` : ""}` : listing ? "Price on request" : "";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: "linear-gradient(135deg,#f5f3ff,#ffffff)", padding: 64, fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, color: "#5b2fd6", fontSize: 36, fontWeight: 800 }}>
          <div style={{ width: 48, height: 48, borderRadius: 12, background: "#6d3ff0" }} />
          {SITE_NAME}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: title.length > 60 ? 54 : 68, fontWeight: 800, color: "#111827", lineHeight: 1.1, maxHeight: 250, overflow: "hidden" }}>{title}</div>
          {price ? <div style={{ fontSize: 56, fontWeight: 800, color: "#5b2fd6" }}>{price}</div> : null}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 30, color: "#596272" }}>
          <div>{seller ? `${seller.name}${seller.city ? ` · ${seller.city}` : ""}` : "Verified suppliers across India"}</div>
          <div>{listing ? "Request a quote" : ""}</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
