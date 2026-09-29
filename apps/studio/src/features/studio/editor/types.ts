import type { StorefrontDocument } from "@cnote/storefront/document";
import type { RenderData } from "@cnote/storefront/render";

export interface SellerImageLite {
  id: string;
  url: string;
  alt: string;
}

export interface VersionLite {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  publishedAt: string | null;
  reviewNote: string | null;
}

export interface EditorInitial {
  document: StorefrontDocument;
  etag: string;
  slug: string;
  status: "draft" | "live" | "suspended";
  templateKey: string | null;
  sellerName: string;
  liveBase: string;
  versions: VersionLite[];
}

export interface EditorData {
  data: RenderData;
  images: SellerImageLite[];
}

// Set once by the editor page (client modules cannot read server env); pickers link here.
export const SELLER_LISTINGS_URL = process.env.NEXT_PUBLIC_SELLER_APP_URL ? `${process.env.NEXT_PUBLIC_SELLER_APP_URL.replace(/\/+$/, "")}/listings` : "http://localhost:3002/listings";
