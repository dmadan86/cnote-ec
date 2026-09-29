// Framework-agnostic storefront renderer (server-component safe). Import from "@cnote/storefront/render".
export { StorefrontView, findPage, type StorefrontViewProps } from "./view";
export { RichTextView, selectProducts } from "./sections";
export { STOREFRONT_CSS } from "./css";
export { themeVars, formatRupees, trustLabel } from "./util";
export type { RenderData, RenderProduct, RenderTestimonial, RenderHrefs, LinkComponent, ImageComponent, LinkProps, ImageProps } from "./types";
