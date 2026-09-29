// The six curated starter templates. Copy is realistic placeholder text with {{name}} / {{city}} tokens that
// applyTemplate() replaces with the seller's real data. Colours are AA-validated by the theme schema (see tests).
import { SCHEMA_VERSION, type ImageRef, type Section, type StorefrontDocument, type Theme } from "../document";

export interface TemplateSeed {
  key: string;
  name: string;
  description: string;
  verticals: string[];
  tags: string[];
  sortOrder: number;
  document: StorefrontDocument;
}

const ph = (key: string): ImageRef => ({ src: `placeholder:${key}`, alt: "" });
type Tone = "default" | "surface" | "brand";
const trust = (): Section => ({ id: "trust", type: "trustStrip", tone: "default" });
const hero = (o: { headline: string; subhead: string; image: string; layout?: "split" | "centered" | "banner"; cta?: string; tone?: Tone }): Section => ({
  id: "hero", type: "hero", tone: o.tone ?? "default", layout: o.layout ?? "split", headline: o.headline, subhead: o.subhead, image: ph(o.image), ctaLabel: o.cta ?? "Request a quote",
});
const grid = (id: string, title: string, limit: number, columns: 2 | 3 | 4 = 3, tone: Tone = "default"): Section => ({ id, type: "productGrid", tone, title, source: { kind: "all" }, limit, columns });
const para = (text: string) => ({ type: "p" as const, children: [{ text }] });
const about = (id: string, title: string, paras: string[], image: string | null, tone: Tone = "default"): Section => ({
  id, type: "about", tone, title, body: paras.map(para), image: image ? ph(image) : null,
});
const stats = (items: [string, string][], tone: Tone = "surface"): Section => ({ id: "stats", type: "stats", tone, items: items.map(([value, label]) => ({ value, label })) });
const certs = (title: string, items: [string, string][]): Section => ({
  id: "certs", type: "certifications", tone: "default", title, items: items.map(([name, issuer]) => ({ name, issuer, year: "" })),
});
const faq = (items: [string, string][], title = "Frequently asked questions", tone: Tone = "default"): Section => ({
  id: "faq", type: "faq", tone, title, items: items.map(([q, a]) => ({ q, a })),
});
const contact = (title: string, body: string, cta = "Request a quote", tone: Tone = "surface"): Section => ({ id: "contact", type: "contact", tone, title, body, ctaLabel: cta, showCity: true });
const reviews = (title = "What buyers say"): Section => ({ id: "reviews", type: "testimonials", tone: "default", title, limit: 3 });
const gallery = (title: string, images: string[]): Section => ({ id: "gallery", type: "gallery", tone: "default", title, images: images.map(ph) });
const featured = (title: string): Section => ({ id: "featured", type: "featuredProduct", tone: "surface", title, listingId: null });
const divider = (id = "divider"): Section => ({ id, type: "divider", tone: "default" });

const seo = (title: string, description: string) => ({ title, description });
const doc = (theme: Theme, pages: StorefrontDocument["pages"]): StorefrontDocument => ({ schemaVersion: SCHEMA_VERSION, theme, pages });

const COMMON_FAQ: [string, string][] = [
  ["What is your minimum order quantity?", "Minimum order quantities are shown on each product. For trial or sample orders, send us a quote request and we will do our best to help."],
  ["Do you deliver across India?", "Yes. We dispatch pan-India through trusted transporters. Delivery time and freight depend on the order size and destination."],
  ["Can you make this to my specification?", "Yes, custom specifications are welcome. Share drawings, samples or requirements in your quote request."],
  ["How do I get a price?", "Use Request a quote. Your request goes through the platform, and we will reply with pricing and lead time."],
];

export const TEMPLATE_SEEDS: TemplateSeed[] = [
  {
    key: "industrial-classic",
    name: "Industrial Classic",
    description: "Sturdy navy-and-amber layout for engineering, machinery and industrial MRO suppliers. Leads with capability, certifications and a clear quote button.",
    verticals: ["industrial-mro", "engineering", "machinery"],
    tags: ["dark-accent", "certifications", "b2b", "manufacturer"],
    sortOrder: 10,
    document: doc(
      { primary: "#1e3a5f", onPrimary: "#ffffff", background: "#ffffff", surface: "#f1f4f8", text: "#111827", muted: "#4b5563", accent: "#d97706", font: "condensed", radius: "sm", logo: null },
      [
        {
          slug: "home", title: "Home", seo: seo("{{name}} | Industrial manufacturer in {{city}}", "{{name}} makes and supplies industrial components from {{city}}. Browse products and request a quote."),
          sections: [
            trust(),
            hero({ headline: "Precision industrial products, built to your specification", subhead: "{{name}} manufactures and supplies dependable components from {{city}}, with consistent quality and on-time dispatch.", image: "factory" }),
            stats([["15+", "Years in manufacturing"], ["500+", "Regular buyers"], ["48 hrs", "Typical quote turnaround"], ["Pan-India", "Dispatch"]]),
            grid("products", "Popular products", 6, 3),
            certs("Quality and compliance", [["ISO 9001 (edit to match yours)", "Certifying body"], ["Material test reports", "Provided with orders"]]),
            reviews(),
            contact("Need a quote?", "Send your drawing, quantity and delivery city. Our team will respond with pricing and lead time."),
          ],
        },
        { slug: "products", title: "Products", seo: seo("Products | {{name}}", "Catalogue of products from {{name}}, {{city}}."), sections: [grid("products", "All products", 24, 3), faq(COMMON_FAQ), contact("Can't find it?", "Tell us what you need and we will confirm if we can make it.")] },
        {
          slug: "about", title: "About", seo: seo("About {{name}}", "About {{name}}, an industrial manufacturer based in {{city}}."),
          sections: [
            about("about", "About {{name}}", ["{{name}} is a manufacturer based in {{city}}. We focus on repeatable quality, honest lead times and long relationships with our buyers.", "Replace this text with your story: when you started, what you make, the industries you serve and what buyers can expect."], "workshop"),
            gallery("Inside our facility", ["factory", "workshop", "warehouse"]),
            contact("Talk to us", "Share your requirement and we will get back to you."),
          ],
        },
      ],
    ),
  },
  {
    key: "packaging-bold",
    name: "Packaging Bold",
    description: "Warm, high-energy layout with big product tiles. Built for corrugated boxes, pouches, labels and other packaging makers who sell on MOQ and price.",
    verticals: ["packaging", "printing"],
    tags: ["bold", "product-first", "warm", "moq"],
    sortOrder: 20,
    document: doc(
      { primary: "#9a3412", onPrimary: "#ffffff", background: "#fffaf5", surface: "#fdeee0", text: "#1c1917", muted: "#57534e", accent: "#ea580c", font: "slab", radius: "lg", logo: null },
      [
        {
          slug: "home", title: "Home", seo: seo("{{name}} | Packaging manufacturer in {{city}}", "Custom packaging from {{name}}, {{city}}. See sizes, minimum orders and request a quote."),
          sections: [
            trust(),
            hero({ headline: "Packaging that protects your product and your brand", subhead: "Custom sizes, printing and quick turnaround from {{name}} in {{city}}. Clear pricing per unit and honest minimum orders.", image: "packaging", layout: "banner", tone: "surface" }),
            grid("products", "Best-selling packaging", 8, 4),
            stats([["3 to 7 ply", "Board options"], ["Custom print", "Up to 4 colours"], ["1,000", "Typical minimum order"], ["7-10 days", "Standard lead time"]], "brand"),
            about("about", "Why buyers choose us", ["We make packaging for food, apparel, electronics and e-commerce brands. Send your product dimensions and we will suggest the right board and design.", "Replace this with what makes your packaging different: materials, print quality, lead time, service."], null),
            reviews("Buyer reviews"),
            faq([["What is the minimum order?", "It depends on the product. Each listing shows its minimum order quantity and unit."], ["Can you print my logo?", "Yes. Share your artwork with the quote request and we will confirm print options."], ["Do you make custom sizes?", "Yes. Tell us the internal dimensions and quantity."]]),
            contact("Get a packaging quote", "Share size, quantity and print requirements. We reply with pricing per unit."),
          ],
        },
        { slug: "products", title: "Products", seo: seo("Products | {{name}}", "Packaging catalogue from {{name}}."), sections: [grid("products", "All packaging", 24, 4), contact("Custom size?", "Send dimensions and quantity for a custom quote.")] },
      ],
    ),
  },
  {
    key: "textile-heritage",
    name: "Textile Heritage",
    description: "Elegant serif layout with a craft-and-provenance story. Suits fabric mills, garment makers, handloom and home-textile suppliers.",
    verticals: ["textiles", "apparel", "handloom"],
    tags: ["serif", "storytelling", "craft", "elegant"],
    sortOrder: 30,
    document: doc(
      { primary: "#831843", onPrimary: "#ffffff", background: "#fffdf7", surface: "#f8f0e3", text: "#292524", muted: "#57534e", accent: "#b45309", font: "serif", radius: "md", logo: null },
      [
        {
          slug: "home", title: "Home", seo: seo("{{name}} | Textiles from {{city}}", "Fabrics and garments from {{name}}, {{city}}. Bulk orders, custom weaves and export-quality finishing."),
          sections: [
            trust(),
            hero({ headline: "Fabric with a story, woven with care", subhead: "From {{city}}, {{name}} supplies quality fabrics and garments for wholesalers, brands and boutiques.", image: "textile", layout: "centered" }),
            about("about", "Our craft", ["Our looms and finishing units combine traditional technique with modern quality control. Every lot is inspected before dispatch.", "Replace this with your heritage: how long you have been making textiles, the fibres you work with and the regions you serve."], "textile", "surface"),
            grid("products", "From our collection", 6, 3),
            gallery("In the mill", ["textile", "workshop", "product"]),
            reviews(),
            contact("Request swatches or a quote", "Tell us the fabric, GSM, width and quantity. We will send a quote and swatches where possible."),
          ],
        },
        { slug: "products", title: "Collection", seo: seo("Collection | {{name}}", "Fabrics and garments from {{name}}."), sections: [grid("products", "Full collection", 24, 3), faq(COMMON_FAQ)] },
      ],
    ),
  },
  {
    key: "minimal-catalogue",
    name: "Minimal Catalogue",
    description: "Quiet, image-forward catalogue with almost no chrome. Best when you have many products and good photos and want buyers to browse quickly.",
    verticals: [],
    tags: ["minimal", "catalogue", "photos", "fast"],
    sortOrder: 40,
    document: doc(
      { primary: "#111827", onPrimary: "#ffffff", background: "#ffffff", surface: "#f5f5f5", text: "#111827", muted: "#525252", accent: "#737373", font: "geometric", radius: "none", logo: null },
      [
        {
          slug: "home", title: "Catalogue", seo: seo("{{name}} | Catalogue", "Product catalogue of {{name}}, {{city}}. Prices, minimum orders and quotes."),
          sections: [
            trust(),
            hero({ headline: "{{name}}", subhead: "Catalogue of products from {{city}}. Prices and minimum orders are listed on every item.", image: "catalogue", layout: "centered" }),
            grid("products", "Products", 24, 4),
            divider(),
            faq([["How do I order?", "Open a product and request a quote. We confirm price, availability and delivery."], ["Do you ship across India?", "Yes, we ship pan-India."]], "Good to know"),
            contact("Ask us anything", "Questions about a product or a bulk order? Send an enquiry.", "Send an enquiry"),
          ],
        },
      ],
    ),
  },
  {
    key: "modern-trust",
    name: "Modern Trust",
    description: "Clean teal layout that puts verification, ratings and buyer reviews up front. Good for newer sellers who want to build confidence quickly.",
    verticals: [],
    tags: ["trust", "modern", "reviews", "verified"],
    sortOrder: 50,
    document: doc(
      { primary: "#0f766e", onPrimary: "#ffffff", background: "#ffffff", surface: "#f0fdfa", text: "#0f172a", muted: "#475569", accent: "#0d9488", font: "humanist", radius: "xl", logo: null },
      [
        {
          slug: "home", title: "Home", seo: seo("{{name}} | Verified supplier in {{city}}", "{{name}} is a verified supplier based in {{city}}. See products, buyer reviews and request a quote."),
          sections: [
            trust(),
            hero({ headline: "A supplier you can verify before you buy", subhead: "{{name}} in {{city}}. Our verification status and buyer reviews on this page come straight from the marketplace.", image: "warehouse" }),
            reviews("Reviews from real buyers"),
            featured("Featured product"),
            grid("products", "Our range", 6, 3),
            about("about", "About {{name}}", ["We are a supplier based in {{city}}. Tell buyers what you make, who you serve and how you keep quality consistent.", "Replace this text with your own story."], null, "surface"),
            stats([["4.5+", "Target buyer rating"], ["24 hrs", "Reply time"], ["Pan-India", "Delivery"]], "brand"),
            faq(COMMON_FAQ),
            contact("Request a quote", "Send your requirement through the marketplace and we will respond with pricing."),
          ],
        },
      ],
    ),
  },
  {
    key: "gifting-festive",
    name: "Gifting & Festive",
    description: "Colourful, celebratory layout for gift hampers, festive decor, sweets and corporate gifting suppliers. Highlights bulk and customised orders.",
    verticals: ["gifting", "festive", "handicrafts"],
    tags: ["colourful", "festive", "corporate-gifting", "bulk"],
    sortOrder: 60,
    document: doc(
      { primary: "#6d28d9", onPrimary: "#ffffff", background: "#fffbf5", surface: "#fef3e2", text: "#1f2937", muted: "#4b5563", accent: "#db2777", font: "geometric", radius: "xl", logo: null },
      [
        {
          slug: "home", title: "Home", seo: seo("{{name}} | Gifts and festive supplies, {{city}}", "Corporate gifts and festive supplies from {{name}}, {{city}}. Bulk and custom orders welcome."),
          sections: [
            trust(),
            hero({ headline: "Gifts that make every celebration count", subhead: "Bulk and customised gifting from {{name}} in {{city}}, for Diwali, weddings, corporate events and more.", image: "gift", layout: "banner", tone: "surface" }),
            grid("products", "Popular gifts", 8, 4),
            about("about", "Corporate and bulk gifting", ["We help businesses gift at scale: branded packaging, greeting cards and timely delivery across India.", "Replace this with your gifting range, customisation options and how early buyers should order for peak season."], "gift"),
            stats([["100+", "Corporate clients"], ["Custom", "Branding and packaging"], ["Pan-India", "Delivery"], ["Order early", "For festive season"]], "brand"),
            gallery("From our workshop", ["gift", "packaging", "product"]),
            reviews(),
            faq([["Can you brand the gift with our logo?", "Yes. Share your logo and quantity with the quote request."], ["How early should we order for Diwali?", "We recommend ordering 4 to 6 weeks ahead for custom work."], ["Do you deliver to multiple addresses?", "Yes, multi-city dispatch can be arranged."]]),
            contact("Plan your gifting order", "Tell us the quantity, budget per gift and delivery date."),
          ],
        },
        { slug: "products", title: "Gifts", seo: seo("Gifts | {{name}}", "Gift catalogue from {{name}}."), sections: [grid("products", "All gifts", 24, 4), contact("Need something custom?", "Share your idea and budget for a custom quote.")] },
      ],
    ),
  },
];
