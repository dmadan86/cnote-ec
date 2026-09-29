// StorefrontDocument v1: the JSON a seller edits in Studio and the renderer draws. It is deliberately a closed,
// strictly typed, size-limited block model so that (a) an AI builder can generate it from the JSON Schema
// (`storefrontJsonSchema()`), (b) the renderer never has to trust free-form HTML/CSS, and (c) platform facts
// (trust strip, testimonials) are NOT seller-editable: those blocks carry no content, the renderer fills them
// from live data.
import { z } from "zod";
import { HEX_RE, themeContrastIssues } from "./contrast";
import { richTextSchema, type RichText } from "./richtext";

export const SCHEMA_VERSION = 1 as const;

export const LIMITS = {
  pages: 6,
  sectionsPerPage: 24,
  documentBytes: 120_000,
  headline: 90,
  subhead: 240,
  title: 80,
  label: 32,
  short: 60,
  body: 600,
  altText: 140,
  productGridMax: 24,
  handpickedMax: 24,
  certifications: 12,
  gallery: 12,
  stats: 6,
  faq: 12,
  testimonials: 6,
  seoTitle: 70,
  seoDescription: 170,
} as const;

/** Allow-listed font stacks. System fonts only: zero web-font bytes on 3G, no third-party font CDN. */
export const FONTS = {
  sans: { label: "Clean sans", stack: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  humanist: { label: "Humanist", stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif' },
  geometric: { label: "Geometric", stack: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, system-ui, sans-serif' },
  serif: { label: "Classic serif", stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, Georgia, serif' },
  slab: { label: "Sturdy slab", stack: 'Rockwell, "Rockwell Nova", "Roboto Slab", "DejaVu Serif", "Sitka Small", serif' },
  condensed: { label: "Industrial", stack: '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif' },
} as const;
export type FontKey = keyof typeof FONTS;
export const FONT_KEYS = Object.keys(FONTS) as [FontKey, ...FontKey[]];

export const RADII = { none: 0, sm: 4, md: 8, lg: 14, xl: 24 } as const;
export type RadiusKey = keyof typeof RADII;

/** Illustrated placeholders drawn by the renderer (no network). Real photos come from the seller's approved images. */
export const PLACEHOLDERS = ["factory", "packaging", "textile", "catalogue", "gift", "warehouse", "workshop", "product"] as const;
export type PlaceholderKey = (typeof PLACEHOLDERS)[number];

const IMAGE_SRC_RE = /^\/media\/listing-images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLACEHOLDER_RE = /^placeholder:([a-z]+)$/;

/** Images are platform media only: an approved listing image or a built-in placeholder. External URLs are rejected. */
export function isPlatformImageSrc(src: string): boolean {
  if (IMAGE_SRC_RE.test(src)) return true;
  const m = PLACEHOLDER_RE.exec(src);
  return !!m && (PLACEHOLDERS as readonly string[]).includes(m[1]!);
}
export const imageIdOf = (src: string): string | null => (IMAGE_SRC_RE.test(src) ? src.split("/").pop()! : null);
export const placeholderOf = (src: string): PlaceholderKey | null => {
  const m = PLACEHOLDER_RE.exec(src);
  return m && (PLACEHOLDERS as readonly string[]).includes(m[1]!) ? (m[1] as PlaceholderKey) : null;
};

const noControl = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const text = (max: number, min = 0) => z.string().trim().min(min).max(max).refine(noControl, "Contains invalid characters.");

const hex = z
  .string()
  .regex(HEX_RE, "Use a #rrggbb colour.")
  .transform((v) => v.toLowerCase());

export const imageRefSchema = z.strictObject({
  src: z.string().max(120).refine(isPlatformImageSrc, "Use an approved platform image."),
  alt: text(LIMITS.altText),
});
export type ImageRef = z.infer<typeof imageRefSchema>;

export const themeSchema = z
  .strictObject({
    primary: hex,
    onPrimary: hex,
    background: hex,
    surface: hex,
    text: hex,
    muted: hex,
    accent: hex,
    font: z.enum(FONT_KEYS),
    radius: z.enum(Object.keys(RADII) as [RadiusKey, ...RadiusKey[]]),
    logo: imageRefSchema.nullable(),
  })
  .superRefine((t, ctx) => {
    for (const i of themeContrastIssues(t)) ctx.addIssue({ code: "custom", path: [i.path.replace(/^theme\./, "")], message: i.message });
  });
export type Theme = z.infer<typeof themeSchema>;

const sectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Section ids are lowercase letters, digits and hyphens.");
const tone = z.enum(["default", "surface", "brand"]).default("default");
const base = { id: sectionId, tone };

const uuid = z.uuid();
const categorySlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/);

export const productSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("category"), categorySlug }),
  z.strictObject({ kind: z.literal("handpicked"), listingIds: z.array(uuid).max(LIMITS.handpickedMax) }),
]);
export type ProductSource = z.infer<typeof productSourceSchema>;

export const sectionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...base,
    type: z.literal("hero"),
    layout: z.enum(["split", "centered", "banner"]).default("split"),
    headline: text(LIMITS.headline, 1),
    subhead: text(LIMITS.subhead),
    image: imageRefSchema.nullable(),
    /** The CTA always opens the platform RFQ form for this seller; sellers cannot point it elsewhere. */
    ctaLabel: text(LIMITS.label, 1),
  }),
  z.strictObject({
    ...base,
    type: z.literal("productGrid"),
    title: text(LIMITS.title),
    source: productSourceSchema,
    limit: z.number().int().min(1).max(LIMITS.productGridMax),
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(3),
  }),
  z.strictObject({
    ...base,
    type: z.literal("featuredProduct"),
    title: text(LIMITS.title),
    /** null = the seller's first public listing */
    listingId: uuid.nullable(),
  }),
  z.strictObject({ ...base, type: z.literal("about"), title: text(LIMITS.title), body: richTextSchema, image: imageRefSchema.nullable() }),
  z.strictObject({
    ...base,
    type: z.literal("certifications"),
    title: text(LIMITS.title),
    items: z.array(z.strictObject({ name: text(LIMITS.short, 1), issuer: text(LIMITS.short), year: text(4) })).max(LIMITS.certifications),
  }),
  z.strictObject({ ...base, type: z.literal("gallery"), title: text(LIMITS.title), images: z.array(imageRefSchema).max(LIMITS.gallery) }),
  z.strictObject({
    ...base,
    type: z.literal("stats"),
    items: z.array(z.strictObject({ value: text(12, 1), label: text(LIMITS.label, 1) })).min(1).max(LIMITS.stats),
  }),
  /** No seller text: reviews are pulled from approved platform reviews at render time. */
  z.strictObject({ ...base, type: z.literal("testimonials"), title: text(LIMITS.title), limit: z.number().int().min(1).max(LIMITS.testimonials) }),
  z.strictObject({
    ...base,
    type: z.literal("faq"),
    title: text(LIMITS.title),
    items: z.array(z.strictObject({ q: text(120, 1), a: text(LIMITS.body, 1) })).min(1).max(LIMITS.faq),
  }),
  z.strictObject({
    ...base,
    type: z.literal("contact"),
    title: text(LIMITS.title),
    body: text(300),
    ctaLabel: text(LIMITS.label, 1),
    showCity: z.boolean(),
  }),
  /** Platform-injected and NOT editable: verification tier, trust score and GST status come from live data. */
  z.strictObject({ ...base, type: z.literal("trustStrip") }),
  z.strictObject({ ...base, type: z.literal("spacer"), size: z.enum(["sm", "md", "lg"]) }),
  z.strictObject({ ...base, type: z.literal("divider") }),
]);
export type Section = z.infer<typeof sectionSchema>;
export type SectionType = Section["type"];
export const SECTION_TYPES = [
  "hero", "productGrid", "featuredProduct", "about", "certifications", "gallery", "stats", "testimonials", "faq", "contact", "trustStrip", "spacer", "divider",
] as const satisfies readonly SectionType[];
export type SectionOf<T extends SectionType> = Extract<Section, { type: T }>;

export const RESERVED_PAGE_SLUGS = ["preview", "api", "media", "static", "_next"];
const pageSlug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,29}$/, "Page slugs are lowercase letters, digits and hyphens.")
  .refine((s) => !RESERVED_PAGE_SLUGS.includes(s), "That page slug is reserved.");

export const pageSchema = z.strictObject({
  slug: pageSlug,
  title: text(LIMITS.title, 1),
  seo: z.strictObject({ title: text(LIMITS.seoTitle), description: text(LIMITS.seoDescription) }),
  sections: z.array(sectionSchema).max(LIMITS.sectionsPerPage),
});
export type Page = z.infer<typeof pageSchema>;

export const storefrontDocumentSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    theme: themeSchema,
    pages: z.array(pageSchema).min(1).max(LIMITS.pages),
  })
  .superRefine((d, ctx) => {
    if (d.pages[0]?.slug !== "home") ctx.addIssue({ code: "custom", path: ["pages", 0, "slug"], message: 'The first page must have the slug "home".' });
    const seenSlugs = new Set<string>();
    d.pages.forEach((p, pi) => {
      const seenIds = new Set<string>();
      if (seenSlugs.has(p.slug)) ctx.addIssue({ code: "custom", path: ["pages", pi, "slug"], message: "Page slugs must be unique." });
      seenSlugs.add(p.slug);
      let strips = 0;
      p.sections.forEach((s, si) => {
        if (seenIds.has(s.id)) ctx.addIssue({ code: "custom", path: ["pages", pi, "sections", si, "id"], message: "Section ids must be unique within a page." });
        seenIds.add(s.id);
        if (s.type === "trustStrip" && ++strips > 1) ctx.addIssue({ code: "custom", path: ["pages", pi, "sections", si], message: "Only one trust strip per page." });
      });
    });
    if (JSON.stringify(d).length > LIMITS.documentBytes) ctx.addIssue({ code: "custom", path: [], message: "The storefront is too large." });
  });
export type StorefrontDocument = z.infer<typeof storefrontDocumentSchema>;
export type StorefrontDocumentInput = z.input<typeof storefrontDocumentSchema>;

export interface DocumentIssue {
  path: string;
  message: string;
}

export type ValidationResult = { ok: true; document: StorefrontDocument } | { ok: false; issues: DocumentIssue[] };

/** Validates untrusted JSON (from the editor, an AI builder or a template). Never throws. */
export function validateDocument(input: unknown): ValidationResult {
  const r = storefrontDocumentSchema.safeParse(input);
  if (r.success) return { ok: true, document: r.data };
  return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
}

/**
 * Like validateDocument, but first shortens strings that only exceed their length limit (used when merging a
 * seller's real business name into template copy, where {{name}} may be longer than the placeholder assumed).
 */
export function validateDocumentClamped(input: unknown): ValidationResult {
  let cur: unknown = structuredClone(input);
  for (let round = 0; round < 6; round++) {
    const r = storefrontDocumentSchema.safeParse(cur);
    if (r.success) return { ok: true, document: r.data };
    const fixable = r.error.issues.filter((i) => i.code === "too_big" && (i as { origin?: string }).origin === "string" && typeof (i as { maximum?: unknown }).maximum === "number");
    if (!fixable.length || fixable.length < r.error.issues.length) return { ok: false, issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
    for (const i of fixable) {
      let node = cur as Record<string | number, unknown>;
      for (const k of i.path.slice(0, -1)) node = node[k as string | number] as Record<string | number, unknown>;
      const last = i.path[i.path.length - 1] as string | number;
      node[last] = String(node[last]).slice(0, (i as unknown as { maximum: number }).maximum).trimEnd();
    }
  }
  return validateDocument(cur);
}

/** JSON Schema for AI builders (structured output / tool input). */
export function storefrontJsonSchema(): unknown {
  return z.toJSONSchema(storefrontDocumentSchema, { io: "input", unrepresentable: "any" });
}

// ---------------------------------------------------------------------------------------------
// Helpers over a validated document
// ---------------------------------------------------------------------------------------------

const richPlain = (rt: RichText) => rt.map((b) => (b.type === "p" ? b.children.map((c) => c.text).join("") : b.items.map((i) => i.map((c) => c.text).join("")).join("\n"))).join("\n");

/** Every seller-authored string (for AI moderation). Platform-injected blocks contribute nothing. */
export function collectText(doc: StorefrontDocument): string[] {
  const out: string[] = [];
  const add = (s: string | undefined | null) => s && s.trim() && out.push(s.trim());
  add(doc.theme.logo?.alt);
  for (const p of doc.pages) {
    add(p.title);
    add(p.seo.title);
    add(p.seo.description);
    for (const s of p.sections) {
      switch (s.type) {
        case "hero": add(s.headline); add(s.subhead); add(s.ctaLabel); add(s.image?.alt); break;
        case "productGrid": add(s.title); break;
        case "featuredProduct": add(s.title); break;
        case "about": add(s.title); add(richPlain(s.body)); add(s.image?.alt); break;
        case "certifications": add(s.title); for (const i of s.items) { add(i.name); add(i.issuer); add(i.year); } break;
        case "gallery": add(s.title); for (const i of s.images) add(i.alt); break;
        case "stats": for (const i of s.items) { add(i.value); add(i.label); } break;
        case "testimonials": add(s.title); break;
        case "faq": add(s.title); for (const i of s.items) { add(i.q); add(i.a); } break;
        case "contact": add(s.title); add(s.body); add(s.ctaLabel); break;
        default: break;
      }
    }
  }
  return out;
}

/** Every ImageRef in the document (theme logo included). */
export function collectImages(doc: StorefrontDocument): ImageRef[] {
  const out: ImageRef[] = [];
  if (doc.theme.logo) out.push(doc.theme.logo);
  for (const p of doc.pages) {
    for (const s of p.sections) {
      if ((s.type === "hero" || s.type === "about") && s.image) out.push(s.image);
      if (s.type === "gallery") out.push(...s.images);
    }
  }
  return out;
}

/** Listing ids referenced by handpicked grids / featured blocks. */
export function collectListingIds(doc: StorefrontDocument): string[] {
  const ids = new Set<string>();
  for (const p of doc.pages) {
    for (const s of p.sections) {
      if (s.type === "featuredProduct" && s.listingId) ids.add(s.listingId);
      if (s.type === "productGrid" && s.source.kind === "handpicked") for (const id of s.source.listingIds) ids.add(id);
    }
  }
  return [...ids];
}

/** Deep-maps every string value (used by template merging). */
export function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}

export const DEFAULT_THEME: Theme = {
  primary: "#3730a3",
  onPrimary: "#ffffff",
  background: "#ffffff",
  surface: "#f4f5f9",
  text: "#111827",
  muted: "#4b5563",
  accent: "#c2410c",
  font: "sans",
  radius: "md",
  logo: null,
};

/** Minimal valid starting document for a business with no template applied yet. */
export function blankDocument(business: { name: string; city?: string | null }): StorefrontDocument {
  const where = business.city ? ` in ${business.city}` : "";
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: { ...DEFAULT_THEME },
    pages: [
      {
        slug: "home",
        title: "Home",
        seo: { title: business.name.slice(0, LIMITS.seoTitle), description: `${business.name}${where}: catalogue, capabilities and quotes.`.slice(0, LIMITS.seoDescription) },
        sections: [
          { id: "trust", type: "trustStrip", tone: "default" },
          {
            id: "hero", type: "hero", tone: "default", layout: "split", headline: business.name.slice(0, LIMITS.headline),
            subhead: `Manufacturer and supplier${where}. Tell us what you need and get a quote.`, image: null, ctaLabel: "Request a quote",
          },
          { id: "products", type: "productGrid", tone: "default", title: "Our products", source: { kind: "all" }, limit: 6, columns: 3 },
          { id: "contact", type: "contact", tone: "surface", title: "Get a quote", body: "Share your requirement and we will respond with pricing and lead time.", ctaLabel: "Request a quote", showCity: true },
        ],
      },
    ],
  };
}

export const newSectionId = (type: string, existing: Iterable<string>): string => {
  const taken = new Set(existing);
  for (let n = 1; ; n++) {
    const id = `${type.toLowerCase()}-${n}`.slice(0, 32);
    if (!taken.has(id)) return id;
  }
};

/** A sensible, valid empty block for the editor's "Add section". */
export function defaultSection(type: SectionType, id: string): Section {
  const b = { id, tone: "default" as const };
  switch (type) {
    case "hero": return { ...b, type, layout: "split", headline: "Your headline", subhead: "", image: null, ctaLabel: "Request a quote" };
    case "productGrid": return { ...b, type, title: "Our products", source: { kind: "all" }, limit: 6, columns: 3 };
    case "featuredProduct": return { ...b, type, title: "Featured product", listingId: null };
    case "about": return { ...b, type, title: "About us", body: [{ type: "p", children: [{ text: "Tell buyers about your business." }] }], image: null };
    case "certifications": return { ...b, type, title: "Certifications", items: [{ name: "ISO 9001", issuer: "", year: "" }] };
    case "gallery": return { ...b, type, title: "Gallery", images: [] };
    case "stats": return { ...b, type, tone: "surface", items: [{ value: "10+", label: "Years in business" }] };
    case "testimonials": return { ...b, type, title: "What buyers say", limit: 3 };
    case "faq": return { ...b, type, title: "Frequently asked questions", items: [{ q: "What is your minimum order quantity?", a: "See each product for its minimum order." }] };
    case "contact": return { ...b, type, tone: "surface", title: "Get a quote", body: "Share your requirement and we will respond with pricing.", ctaLabel: "Request a quote", showCity: true };
    case "trustStrip": return { ...b, type };
    case "spacer": return { ...b, type, size: "md" };
    case "divider": return { ...b, type };
  }
}

export const SECTION_LABELS: Record<SectionType, string> = {
  hero: "Hero", productGrid: "Product grid", featuredProduct: "Featured product", about: "About", certifications: "Certifications", gallery: "Gallery",
  stats: "Key numbers", testimonials: "Buyer reviews (platform)", faq: "FAQ", contact: "Contact / RFQ", trustStrip: "Trust strip (platform)", spacer: "Spacer", divider: "Divider",
};
