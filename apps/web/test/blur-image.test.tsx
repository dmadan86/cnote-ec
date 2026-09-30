import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BlurImage } from "@/features/media/blur-image";
import { ProductImage } from "@/features/search/product-image";

const BLUR = "data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const html = (n: React.ReactElement) => renderToStaticMarkup(n);

describe("BlurImage (blur-up)", () => {
  it("lazy-loads by default and uses fill (no layout shift)", () => {
    const h = html(<BlurImage src="/media/listing-images/a" alt="" sizes="50vw" />);
    expect(h).toContain('loading="lazy"');
    expect(h).toContain('data-nimg="fill"');
  });

  it("is eager with high fetch priority when priority", () => {
    const h = html(<BlurImage src="/media/listing-images/a" alt="" sizes="50vw" priority />);
    expect(h).toContain('loading="eager"');
    expect(h).toContain('fetchPriority="high"');
    expect(h).not.toContain('loading="lazy"');
  });

  it("applies the blur placeholder as the image background and skips the shimmer", () => {
    const h = html(<BlurImage src="/media/listing-images/a" alt="" sizes="50vw" blurDataUrl={BLUR} />);
    expect(h).toContain(BLUR);
    expect(h).not.toContain("animate-pulse");
  });

  it("falls back to a shimmer (reduced-motion safe) when there is no placeholder", () => {
    const h = html(<BlurImage src="/media/listing-images/a" alt="" sizes="50vw" />);
    expect(h).toContain("animate-pulse");
    expect(h).toContain("motion-reduce:animate-none");
    expect(h).toContain("aria-hidden");
  });

  it("disables the de-blur transition under prefers-reduced-motion", () => {
    expect(html(<BlurImage src="/media/listing-images/a" alt="" sizes="50vw" />)).toContain("motion-reduce:transition-none");
  });

  it("skips the placeholder for SVG art and keeps it unoptimised", () => {
    const h = html(<BlurImage src="/seed/a.svg" alt="" sizes="50vw" blurDataUrl={BLUR} />);
    expect(h).not.toContain(BLUR);
    expect(h).toContain('src="/seed/a.svg"');
  });

  it("keeps alt text semantics (decorative empty alt, meaningful alt preserved)", () => {
    expect(html(<BlurImage src="/x/a" alt="" sizes="1vw" />)).toContain('alt=""');
    expect(html(<BlurImage src="/x/a" alt="Steel valve" sizes="1vw" />)).toContain('alt="Steel valve"');
  });

  it("supports intrinsic width/height without fill", () => {
    const h = html(<BlurImage src="/x/a" alt="" width={800} height={600} sizes="1vw" />);
    expect(h).toContain('width="800"');
    expect(h).toContain('height="600"');
    expect(h).not.toContain("animate-pulse");
  });
});

describe("ProductImage", () => {
  it("renders the icon fallback without src and passes the blur through", () => {
    expect(html(<ProductImage src={undefined} sizes="1vw" />)).not.toContain("<img");
    expect(html(<ProductImage src="/media/listing-images/a" sizes="1vw" blur={BLUR} />)).toContain(BLUR);
  });
});
