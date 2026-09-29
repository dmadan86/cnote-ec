import Image from "next/image";
import Link from "next/link";
import { StorefrontView, findPage } from "@cnote/storefront/render";
import type { ImageProps, LinkProps, RenderData, RenderHrefs, RenderProduct } from "@cnote/storefront/render";
import type { StorefrontDocument } from "@cnote/storefront/document";
import { productPath } from "@/lib/paths";

const StoreLink = ({ href, children, ...rest }: LinkProps) => (
  <Link href={href} prefetch={false} {...rest}>{children}</Link>
);

const StoreImage = ({ src, alt, width = 800, height = 600, sizes, priority, className, style }: ImageProps) => (
  <Image
    src={src}
    alt={alt}
    width={width}
    height={height}
    sizes={sizes}
    className={className}
    style={style}
    unoptimized={src.split("?")[0]!.endsWith(".svg")}
    {...(priority ? { loading: "eager" as const, fetchPriority: "high" as const } : {})}
  />
);

export const storePagePath = (slug: string, page: string) => (page === "home" ? `/store/${slug}` : `/store/${slug}/${page}`);

/** Web wiring for the shared renderer: next/link + next/image, canonical product URLs, RFQ pre-targeted at the seller. */
export function StorefrontPage({ slug, document, pageSlug, data }: { slug: string; document: StorefrontDocument; pageSlug: string; data: RenderData }) {
  const hrefs: RenderHrefs = {
    page: (p) => storePagePath(slug, p),
    product: (p: RenderProduct) => productPath(p),
    rfq: `/rfq/new?seller=${data.business.id}`,
  };
  return <StorefrontView document={document} pageSlug={findPage(document, pageSlug).slug} data={data} hrefs={hrefs} Link={StoreLink} Image={StoreImage} />;
}
