import type { ComponentType, CSSProperties, ReactNode } from "react";

/** Public listing as the renderer needs it (already filtered to published + approved by the loader). */
export interface RenderProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  imageAlt: string;
  pricePaise: number | null;
  priceUnit: string | null;
  moq: number | null;
  moqUnit: string | null;
  categorySlug: string;
  categoryName: string;
}

export interface RenderTestimonial {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  productTitle: string;
  verifiedEnquiry: boolean;
}

/**
 * Live, platform-owned facts injected at render time. Nothing in here can be authored by the seller
 * (ADR-003: trust is never for sale and never self-declared).
 */
export interface RenderData {
  business: { id: string; name: string; city: string | null; state: string | null };
  trust: { tier: number; score: number; badgeActive: boolean; gstVerified: boolean };
  rating: { average: number; count: number } | null;
  products: RenderProduct[];
  categories: { slug: string; name: string }[];
  testimonials: RenderTestimonial[];
  /**
   * Embed keys (`youtube:<id>`, `vimeo:<id>`) staff or the auto-approver have cleared. A third-party video is only rendered when its
   * key is here; absent means none are (fail closed). Maps need no approval.
   */
  approvedEmbeds?: string[];
}

export interface LinkProps {
  href: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  "aria-current"?: "page";
  "aria-label"?: string;
}
export interface ImageProps {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  className?: string;
  style?: CSSProperties;
  sizes?: string;
  priority?: boolean;
}
/**
 * What the renderer hands the host app for an `embed` block. The host decides how the third-party frame is loaded: the buyer web
 * wraps it in a consent gate (nothing loads before consent); Studio's preview and any host without one shows only a link.
 */
export interface EmbedProps {
  kind: "youtube" | "vimeo" | "map";
  /** privacy-enhanced iframe URL on an origin from EMBED_FRAME_ORIGINS */
  src: string;
  /** accessible name of the frame */
  title: string;
  /** third party named in the consent placeholder */
  provider: string;
  /** consent category that unlocks it */
  category: "marketing" | "functional";
  /** plain link to the same content on the provider's site */
  href: string;
}
export type EmbedComponent = ComponentType<EmbedProps>;
export type LinkComponent = ComponentType<LinkProps>;
export type ImageComponent = ComponentType<ImageProps>;

export interface RenderHrefs {
  /** Link to a page of this storefront ("home" is the root). */
  page(slug: string): string;
  product(p: RenderProduct): string;
  /** RFQ entry with the seller pre-selected. */
  rfq: string;
}
