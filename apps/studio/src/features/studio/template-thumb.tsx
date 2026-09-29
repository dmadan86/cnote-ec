import { StorefrontView, type RenderHrefs } from "@cnote/storefront/render";
import type { StorefrontDocument } from "@cnote/storefront/document";
import { SAMPLE_DATA } from "./sample-data";

const hrefs: RenderHrefs = { page: () => "#", product: () => "#", rfq: "#" };

const FULL = 1200;

/** Live thumbnail: the real renderer drawn at desktop width and scaled down. Decorative and inert (not focusable, hidden from AT). */
export function TemplateThumb({ document, width = 320, height = 220 }: { document: StorefrontDocument; width?: number; height?: number }) {
  const scale = width / FULL;
  return (
    <div aria-hidden className="relative overflow-hidden rounded-t-card border-b border-line bg-surface" style={{ width, height }}>
      <div inert style={{ width: FULL, transform: `scale(${scale})`, transformOrigin: "top left", pointerEvents: "none" }}>
        <StorefrontView document={document} data={SAMPLE_DATA} hrefs={hrefs} preview />
      </div>
    </div>
  );
}
