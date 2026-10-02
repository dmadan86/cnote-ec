import type { CSSProperties, ReactNode } from "react";
import { placeholderOf, type ImageRef, type Page, type PlaceholderKey, type Section, type SectionOf, type StorefrontDocument } from "../document/schema";
import type { Inline, RichText } from "../document/richtext";
import { embedSpec } from "../document/embed";
import type { EmbedComponent, ImageComponent, LinkComponent, RenderData, RenderHrefs, RenderProduct } from "./types";
import { formatRupees, headingId, rgba, trustLabel } from "./util";

export interface Ctx {
  doc: StorefrontDocument;
  page: Page;
  data: RenderData;
  hrefs: RenderHrefs;
  Link: LinkComponent;
  Image: ImageComponent;
  Embed: EmbedComponent;
  /** STOREFRONT_EMBEDS_ENABLED: while off, a stored embed block renders nothing */
  embeds: boolean;
  /** editor preview: empty platform-driven blocks explain themselves instead of vanishing */
  preview: boolean;
  /** heading level for the block title; the first hero on a page owns the h1 */
  h1Taken: { current: boolean };
}

type H = "h1" | "h2";
const PATTERNS: Record<PlaceholderKey, (c: string) => string> = {
  factory: (c) => `repeating-linear-gradient(90deg,${rgba(c, 0.18)} 0 14px,transparent 14px 28px)`,
  packaging: (c) => `repeating-linear-gradient(45deg,${rgba(c, 0.18)} 0 12px,transparent 12px 24px)`,
  textile: (c) => `repeating-linear-gradient(0deg,${rgba(c, 0.16)} 0 2px,transparent 2px 10px),repeating-linear-gradient(90deg,${rgba(c, 0.16)} 0 2px,transparent 2px 10px)`,
  catalogue: (c) => `linear-gradient(${rgba(c, 0.16)} 1px,transparent 1px),linear-gradient(90deg,${rgba(c, 0.16)} 1px,transparent 1px)`,
  gift: (c) => `radial-gradient(${rgba(c, 0.28)} 3px,transparent 4px)`,
  warehouse: (c) => `repeating-linear-gradient(0deg,${rgba(c, 0.18)} 0 16px,transparent 16px 32px)`,
  workshop: (c) => `repeating-conic-gradient(${rgba(c, 0.14)} 0 25%,transparent 0 50%)`,
  product: (c) => `radial-gradient(circle at 30% 30%,${rgba(c, 0.3)},transparent 60%)`,
};
const PATTERN_SIZE: Partial<Record<PlaceholderKey, string>> = { catalogue: "24px 24px", gift: "22px 22px", workshop: "36px 36px" };

/** Approved platform image, or a built-in illustrated placeholder (no network). Decorative when alt is empty. */
export function Pic({ img, ctx, sizes, priority, className }: { img: ImageRef; ctx: Ctx; sizes?: string; priority?: boolean; className?: string }) {
  const ph = placeholderOf(img.src);
  if (ph) {
    const style: CSSProperties = { backgroundImage: PATTERNS[ph](ctx.doc.theme.accent), backgroundSize: PATTERN_SIZE[ph] };
    return img.alt ? <span role="img" aria-label={img.alt} className={`sf-ph ${className ?? ""}`} style={style} /> : <span aria-hidden className={`sf-ph ${className ?? ""}`} style={style} />;
  }
  const I = ctx.Image;
  return <I src={img.src} alt={img.alt} width={800} height={600} sizes={sizes} priority={priority} className={`sf-img ${className ?? ""}`} />;
}

const Runs = ({ xs, ctx }: { xs: Inline[]; ctx: Ctx }) => (
  <>
    {xs.map((r, i) => {
      let n: ReactNode = r.text;
      if (r.bold) n = <strong>{n}</strong>;
      if (r.italic) n = <em>{n}</em>;
      if (r.href) n = <a href={r.href} rel="noopener noreferrer nofollow ugc" target="_blank">{n}<span className="sf-sr"> (opens in a new tab)</span></a>;
      void ctx;
      return <span key={i}>{n}</span>;
    })}
  </>
);

export function RichTextView({ body, ctx }: { body: RichText; ctx: Ctx }) {
  return (
    <div className="sf-rich">
      {body.map((b, i) =>
        b.type === "p" ? (
          <p key={i}><Runs xs={b.children} ctx={ctx} /></p>
        ) : b.type === "ul" ? (
          <ul key={i}>{b.items.map((it, j) => <li key={j}><Runs xs={it} ctx={ctx} /></li>)}</ul>
        ) : (
          <ol key={i}>{b.items.map((it, j) => <li key={j}><Runs xs={it} ctx={ctx} /></li>)}</ol>
        ),
      )}
    </div>
  );
}

function Band({ s, children, className }: { s: Section; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={headingId(s.id)} className={`sf-sec sf-tone-${s.tone} ${className ?? ""}`}>
      <div className="sf-wrap">{children}</div>
    </section>
  );
}
/** A titled block always has an accessible name, even when the seller left the visible title empty. */
function Title({ s, title, fallback }: { s: Section; title: string; fallback: string }) {
  return title ? <h2 id={headingId(s.id)}>{title}</h2> : <h2 id={headingId(s.id)} className="sf-sr">{fallback}</h2>;
}

function ProductCard({ p, ctx, first }: { p: RenderProduct; ctx: Ctx; first: boolean }) {
  const L = ctx.Link;
  return (
    <li className="sf-card">
      {p.imageUrl ? <Pic img={{ src: p.imageUrl, alt: p.imageAlt }} ctx={ctx} sizes="(min-width:768px) 25vw, 50vw" priority={first} /> : <Pic img={{ src: "placeholder:product", alt: "" }} ctx={ctx} />}
      <div className="sf-card-body">
        <L href={ctx.hrefs.product(p)} className="sf-title">{p.title}</L>
        {p.pricePaise != null ? <p className="sf-price">{formatRupees(p.pricePaise)}{p.priceUnit ? ` / ${p.priceUnit}` : ""}</p> : <p className="sf-muted">Price on request</p>}
        {p.moq ? <p className="sf-muted" style={{ fontSize: ".875rem" }}>Min. order: {p.moq}{p.moqUnit ? ` ${p.moqUnit}` : ""}</p> : null}
      </div>
    </li>
  );
}

export function selectProducts(s: SectionOf<"productGrid">, data: RenderData): RenderProduct[] {
  const byId = new Map(data.products.map((p) => [p.id, p]));
  const list =
    s.source.kind === "handpicked"
      ? s.source.listingIds.flatMap((id) => byId.get(id) ?? [])
      : s.source.kind === "category"
        ? data.products.filter((p) => p.categorySlug === (s.source as { categorySlug: string }).categorySlug)
        : data.products;
  return list.slice(0, s.limit);
}

function Empty({ ctx, children }: { ctx: Ctx; children: ReactNode }) {
  return ctx.preview ? <p className="sf-note">{children}</p> : null;
}

function TrustStrip({ s, ctx }: { s: SectionOf<"trustStrip">; ctx: Ctx }) {
  const { trust, rating, business } = ctx.data;
  const t = trustLabel(trust);
  return (
    <section aria-label="Verified by the platform" className="sf-trust" id={`sf-${s.id}`}>
      <div className="sf-wrap">
        <ul>
          <li className="sf-chip"><span aria-hidden>{t.verified ? "✓" : "○"}</span> {t.label}</li>
          {trust.gstVerified ? <li className="sf-chip"><span aria-hidden>✓</span> GST verified</li> : null}
          <li className="sf-chip">Trust score {trust.score}/100</li>
          {rating && rating.count > 0 ? <li className="sf-chip"><span aria-hidden>★</span> {rating.average.toFixed(1)} from {rating.count} buyer {rating.count === 1 ? "review" : "reviews"}</li> : null}
          {business.city ? <li className="sf-chip">{business.city}{business.state ? `, ${business.state}` : ""}</li> : null}
        </ul>
      </div>
    </section>
  );
}

export function SectionView({ s, ctx, index }: { s: Section; ctx: Ctx; index: number }) {
  const L = ctx.Link;
  switch (s.type) {
    case "trustStrip":
      return <TrustStrip s={s} ctx={ctx} />;
    case "hero": {
      const H: H = ctx.h1Taken.current ? "h2" : "h1";
      ctx.h1Taken.current = true;
      const text = (
        <div>
          <H id={headingId(s.id)} style={H === "h2" ? { marginBottom: 0 } : undefined}>{s.headline}</H>
          {s.subhead ? <p className="sf-sub sf-muted">{s.subhead}</p> : null}
          <div className="sf-actions"><L href={ctx.hrefs.rfq} className="sf-btn">{s.ctaLabel}</L></div>
        </div>
      );
      const img = s.image ? <Pic img={s.image} ctx={ctx} priority={index < 2} sizes="(min-width:768px) 45vw, 100vw" /> : null;
      return (
        <section aria-labelledby={headingId(s.id)} className={`sf-sec sf-hero sf-tone-${s.tone}`}>
          <div className={`sf-wrap ${s.layout === "banner" ? "sf-banner-img" : ""}`}>
            {s.layout === "banner" ? (<>{img}{text}</>) : (
              <div className={`sf-hero-grid ${s.layout === "split" && img ? "sf-split" : ""} ${s.layout === "centered" ? "sf-hero-centered" : ""}`}>{text}{s.layout === "split" ? img : null}</div>
            )}
          </div>
        </section>
      );
    }
    case "productGrid": {
      const items = selectProducts(s, ctx.data);
      if (!items.length) return <Empty ctx={ctx}>Product grid: no matching public listings yet. Publish and get listings approved to fill this block.</Empty>;
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback="Products" />
          <ul className="sf-grid" style={{ ["--sf-cols" as string]: s.columns, listStyle: "none", padding: 0 }}>
            {items.map((p, i) => <ProductCard key={p.id} p={p} ctx={ctx} first={index < 3 && i < 4} />)}
          </ul>
        </Band>
      );
    }
    case "featuredProduct": {
      const p = (s.listingId ? ctx.data.products.find((x) => x.id === s.listingId) : ctx.data.products[0]) ?? null;
      if (!p) return <Empty ctx={ctx}>Featured product: no public listing to show yet.</Empty>;
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback="Featured product" />
          <div className="sf-two">
            <Pic img={p.imageUrl ? { src: p.imageUrl, alt: p.imageAlt } : { src: "placeholder:product", alt: "" }} ctx={ctx} sizes="(min-width:768px) 45vw, 100vw" />
            <div>
              <h3><L href={ctx.hrefs.product(p)} className="sf-title" style={{ color: "inherit" }}>{p.title}</L></h3>
              {p.pricePaise != null ? <p className="sf-price" style={{ marginTop: 8 }}>{formatRupees(p.pricePaise)}{p.priceUnit ? ` / ${p.priceUnit}` : ""}</p> : null}
              {p.moq ? <p className="sf-muted">Min. order: {p.moq}{p.moqUnit ? ` ${p.moqUnit}` : ""}</p> : null}
              <div className="sf-actions" style={{ marginTop: 16 }}><L href={ctx.hrefs.rfq} className="sf-btn">Request a quote</L></div>
            </div>
          </div>
        </Band>
      );
    }
    case "about":
      return (
        <Band s={s}>
          <div className={s.image ? "sf-two" : undefined}>
            <div><Title s={s} title={s.title} fallback="About" /><RichTextView body={s.body} ctx={ctx} /></div>
            {s.image ? <Pic img={s.image} ctx={ctx} sizes="(min-width:768px) 45vw, 100vw" /> : null}
          </div>
        </Band>
      );
    case "certifications":
      if (!s.items.length) return null;
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback="Certifications" />
          <ul className="sf-list">
            {s.items.map((c, i) => (
              <li key={i}><strong>{c.name}</strong>{c.issuer ? <span className="sf-muted"> · {c.issuer}</span> : null}{c.year ? <span className="sf-muted"> · {c.year}</span> : null}</li>
            ))}
          </ul>
          <p className="sf-muted" style={{ marginTop: 10, fontSize: ".85rem" }}>Certifications are declared by the seller. Platform verification is shown in the trust strip.</p>
        </Band>
      );
    case "gallery":
      if (!s.images.length) return <Empty ctx={ctx}>Gallery: add approved images.</Empty>;
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback="Gallery" />
          <ul className="sf-gallery" style={{ listStyle: "none", padding: 0 }}>{s.images.map((im, i) => <li key={i}><Pic img={im} ctx={ctx} sizes="(min-width:768px) 33vw, 50vw" /></li>)}</ul>
        </Band>
      );
    case "embed": {
      if (!ctx.embeds) return null;
      const spec = embedSpec(s.source);
      const E = ctx.Embed;
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback={spec.provider} />
          <div className="sf-embed"><E kind={spec.kind} src={spec.src} title={s.title} provider={spec.provider} category={spec.category} href={spec.href} /></div>
        </Band>
      );
    }
    case "stats":
      return (
        <Band s={s}>
          <h2 id={headingId(s.id)} className="sf-sr">Key numbers</h2>
          <dl className="sf-stats" style={{ ["--sf-n" as string]: Math.min(s.items.length, 4) }}>
            {s.items.map((it, i) => (
              <div key={i} className="sf-stat"><dt>{it.value}</dt><dd>{it.label}</dd></div>
            ))}
          </dl>
        </Band>
      );
    case "testimonials": {
      const items = ctx.data.testimonials.slice(0, s.limit);
      if (!items.length) return <Empty ctx={ctx}>Buyer reviews appear here automatically once buyers leave approved reviews on your products. You cannot type reviews yourself.</Empty>;
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback="Buyer reviews" />
          <ul className="sf-grid" style={{ ["--sf-cols" as string]: Math.min(items.length, 3), listStyle: "none", padding: 0 }}>
            {items.map((t) => (
              <li key={t.id} className="sf-quote">
                <p><span aria-hidden>{"★".repeat(t.rating)}{"☆".repeat(5 - t.rating)}</span><span className="sf-sr">{t.rating} out of 5</span></p>
                <blockquote>{t.title ? <strong>{t.title}. </strong> : null}{t.body}</blockquote>
                <p className="sf-muted" style={{ marginTop: 8, fontSize: ".875rem" }}>{t.authorName} on {t.productTitle}{t.verifiedEnquiry ? " · Verified enquiry" : ""}</p>
              </li>
            ))}
          </ul>
        </Band>
      );
    }
    case "faq":
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback="FAQ" />
          <div className="sf-faq">{s.items.map((f, i) => <details key={i}><summary>{f.q}</summary><p>{f.a}</p></details>)}</div>
        </Band>
      );
    case "contact": {
      const { business } = ctx.data;
      return (
        <Band s={s}>
          <Title s={s} title={s.title} fallback="Contact" />
          {s.body ? <p style={{ maxWidth: "60ch" }}>{s.body}</p> : null}
          {s.showCity && business.city ? <p style={{ marginTop: 8 }}>{business.name} · {business.city}{business.state ? `, ${business.state}` : ""}</p> : null}
          <div className="sf-actions" style={{ marginTop: 16 }}><L href={ctx.hrefs.rfq} className="sf-btn">{s.ctaLabel}</L></div>
          <p className="sf-muted" style={{ marginTop: 10, fontSize: ".85rem" }}>Requests go through the platform, so the seller only sees serious, verified enquiries. Phone and email are shared after the seller accepts.</p>
        </Band>
      );
    }
    case "spacer":
      return <div aria-hidden style={{ height: s.size === "sm" ? 16 : s.size === "md" ? 40 : 80 }} />;
    case "divider":
      return <hr className="sf-divider" />;
  }
}
