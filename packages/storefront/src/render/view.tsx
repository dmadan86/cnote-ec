import type { EmbedComponent, EmbedProps, ImageProps, LinkProps, RenderData, RenderHrefs, ImageComponent, LinkComponent } from "./types";
import { type Page, type StorefrontDocument, type Section } from "../document/schema";
import { embedsEnabled } from "../document/embed";
import { STOREFRONT_CSS } from "./css";
import { Pic, SectionView, type Ctx } from "./sections";
import { themeVars } from "./util";

const PlainLink = ({ href, children, ...rest }: LinkProps) => <a href={href} {...rest}>{children}</a>;
// eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
const PlainImage = ({ src, alt, width, height, sizes, priority, ...rest }: ImageProps) => <img src={src} alt={alt} width={width} height={height} sizes={sizes} loading={priority ? "eager" : "lazy"} decoding="async" {...rest} />;

/**
 * Default for hosts without a consent gate (Studio preview, tests, emails): NO third-party frame, only a link the visitor chooses to
 * follow. The renderer itself never emits an <iframe>.
 */
const PlainEmbed = ({ href, provider, title }: EmbedProps) => (
  <p>
    <a href={href} rel="noopener noreferrer nofollow" target="_blank">{title}: open on {provider}<span className="sf-sr"> (opens in a new tab)</span></a>
  </p>
);

export interface StorefrontViewProps {
  document: StorefrontDocument;
  /** page slug to render; unknown slugs fall back to the first page */
  pageSlug?: string;
  data: RenderData;
  hrefs: RenderHrefs;
  Link?: LinkComponent;
  Image?: ImageComponent;
  /** third-party video/map frame (the buyer web passes a consent-gated one); default: a plain link, no frame */
  Embed?: EmbedComponent;
  /** render `embed` blocks (STOREFRONT_EMBEDS_ENABLED). Default: the server env. The Studio editor is client-side and gets it as a prop. */
  embedsEnabled?: boolean;
  /** editor/preview affordances (explains empty platform-driven blocks) */
  preview?: boolean;
}

export const findPage = (doc: StorefrontDocument, slug?: string): Page => doc.pages.find((p) => p.slug === (slug ?? "home")) ?? doc.pages[0]!;

/**
 * The storefront renderer. Framework-agnostic and Server-Component safe: no `next/*`, no hooks, no client state.
 * Web passes next/link + next/image; Studio's preview passes inert equivalents. The platform trust strip is always
 * present: if a page does not place one, it is prepended, so a seller cannot hide verification status.
 */
export function StorefrontView({ document: doc, pageSlug, data, hrefs, Link = PlainLink, Image = PlainImage, Embed = PlainEmbed, embedsEnabled: embeds = embedsEnabled(), preview = false }: StorefrontViewProps) {
  const page = findPage(doc, pageSlug);
  const ctx: Ctx = { doc, page, data, hrefs, Link, Image, Embed, embeds, preview, h1Taken: { current: false } };
  const hasHero = page.sections.some((s) => s.type === "hero");
  const sections: Section[] = page.sections.some((s) => s.type === "trustStrip") ? page.sections : [{ id: "platform-trust", type: "trustStrip", tone: "default" }, ...page.sections];
  const multi = doc.pages.length > 1;
  const logo = doc.theme.logo;
  if (hasHero === false) ctx.h1Taken.current = true;
  return (
    <div className="sf" style={themeVars(doc.theme)} data-storefront-page={page.slug}>
      <style>{STOREFRONT_CSS}</style>
      <div className="sf-header">
        <div className="sf-wrap">
          <Link href={hrefs.page("home")} className="sf-brand">
            {logo ? <span style={{ display: "inline-flex" }}><Pic img={{ src: logo.src, alt: "" }} ctx={ctx} className="sf-logo" /></span> : null}
            <span>{data.business.name}</span>
          </Link>
          {multi ? (
            <nav aria-label="Store pages" className="sf-nav">
              {doc.pages.map((p) => (
                <Link key={p.slug} href={hrefs.page(p.slug)} aria-current={p.slug === page.slug ? "page" : undefined}>{p.title}</Link>
              ))}
            </nav>
          ) : null}
        </div>
      </div>
      {hasHero ? null : (
        <div className="sf-wrap" style={{ paddingTop: 32 }}>
          <h1>{page.title}</h1>
        </div>
      )}
      {sections.map((s, i) => <SectionView key={s.id} s={s} ctx={ctx} index={i} />)}
      <div className="sf-footer">
        <div className="sf-wrap">
          <p><strong>{data.business.name}</strong>{data.business.city ? ` · ${data.business.city}` : ""}</p>
          <p className="sf-muted">Verification and reviews on this page come from the marketplace and cannot be edited by the seller.</p>
        </div>
      </div>
    </div>
  );
}
