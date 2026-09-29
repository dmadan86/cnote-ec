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
export type LinkComponent = ComponentType<LinkProps>;
export type ImageComponent = ComponentType<ImageProps>;

export interface RenderHrefs {
  /** Link to a page of this storefront ("home" is the root). */
  page(slug: string): string;
  product(p: RenderProduct): string;
  /** RFQ entry with the seller pre-selected. */
  rfq: string;
}
