import "server-only";
import { API_PUBLIC_URL, absoluteUrl } from "@/lib/site-url";
import { categoryPath, productPath, sellerPath } from "@/lib/paths";
import { loadCategories, loadFeatured, loadLandingKeywords, loadSellers } from "@/features/search/data";
import { SITE_NAME, SITE_TAGLINE } from "@/features/shell/site";

const SUMMARY = `${SITE_NAME} is an AI-first B2B marketplace for Indian MSMEs. Buyers find verified manufacturers and suppliers across India, compare real prices and minimum order quantities, and request quotes. Suppliers are ranked by relevance and verified trust, never by payment.`;

const inr = (paise: number | null, unit: string | null) => (paise == null ? "price on request" : `INR ${(paise / 100).toLocaleString("en-IN")}${unit ? ` per ${unit}` : ""}`);

function header() {
  return [
    `# ${SITE_NAME}`,
    "",
    `> ${SUMMARY}`,
    "",
    "## Facts for AI assistants",
    "",
    "- Market: India. Currency: INR. Language: English (en-IN).",
    "- Prices shown on product pages are indicative; the supplier confirms the final quote for the buyer's quantity and delivery location.",
    "- Trust: every supplier has a verification tier (0 phone verified, 1 GST verified, 2 KYC verified, 3 audited) and a 0-100 trust score. Ranking uses relevance and trust only. There is no paid placement.",
    "- Reviews: only staff-approved reviews are public and only they count toward ratings.",
    "- Every product page has schema.org Product/Offer/AggregateRating/BreadcrumbList JSON-LD and a plain HTML specifications table.",
    `- Sitemap: ${absoluteUrl("/sitemap.xml")}`,
    "",
    "## Key pages",
    "",
    `- [Home](${absoluteUrl("/")}): search and featured products`,
    `- [All categories](${absoluteUrl("/categories")}): browse products by category`,
    `- [Manufacturers and suppliers](${absoluteUrl("/manufacturers")}): trust-ranked supplier directory`,
    `- [Search](${absoluteUrl("/search")}): free-text search (not indexed; use category pages for stable URLs)`,
    `- [Pricing for sellers](${absoluteUrl("/pricing")}): plans for suppliers`,
    "",
    "## URL patterns",
    "",
    `- Product: ${absoluteUrl("/p/<slug>-<uuid>")}`,
    `- Category: ${absoluteUrl("/c/<category-slug>")}`,
    `- Supplier: ${absoluteUrl("/manufacturers/<uuid>")}`,
    `- Keyword landing page: ${absoluteUrl("/s/<category-slug>/<keyword>")}`,
    "",
    "## Public API",
    "",
    `- [API documentation](${API_PUBLIC_URL}/docs): interactive reference`,
    `- [OpenAPI specification](${API_PUBLIC_URL}/openapi.json): machine-readable, for tool use and code generation`,
    "- Read endpoints for categories, listings and suppliers are public; seller write endpoints need an API token (created by sellers in their account under Developers).",
    "",
  ];
}

/** /llms.txt: concise index in the llmstxt.org format. */
export async function buildLlmsTxt(): Promise<string> {
  const categories = await loadCategories();
  const lines = header();
  if (categories.length) {
    lines.push("## Categories", "");
    for (const c of categories) lines.push(`- [${c.name}](${absoluteUrl(categoryPath(c.slug))})`);
    lines.push("");
  }
  lines.push("## Optional", "", `- [Full catalogue overview for LLMs](${absoluteUrl("/llms-full.txt")}): categories, featured products and top suppliers with prices and links`, "");
  return lines.join("\n");
}

/** /llms-full.txt: everything above plus category descriptions, featured products and top suppliers, as plain markdown. */
export async function buildLlmsFullTxt(): Promise<string> {
  const [categories, featured, sellers, keywords] = await Promise.all([loadCategories(), loadFeatured("popular", 50), loadSellers({ limit: 50 }), loadLandingKeywords()]);
  const lines = header();
  lines.push("## Categories", "");
  for (const c of categories) {
    lines.push(`### ${c.name}`, "", `URL: ${absoluteUrl(categoryPath(c.slug))}`);
    if (c.attributeSchema.fields.length) lines.push(`Specification fields: ${c.attributeSchema.fields.map((f) => f.label + (f.unit ? ` (${f.unit})` : "")).join(", ")}`);
    if (keywords[c.slug]?.length) lines.push(`Popular searches: ${keywords[c.slug]!.join(", ")}`);
    lines.push("");
  }
  lines.push("## Featured products", "");
  const sellerName = new Map(sellers.map((s) => [s.businessId, s.name]));
  for (const l of featured) {
    lines.push(`- [${l.title}](${absoluteUrl(productPath(l))}): ${inr(l.pricePaise, l.priceUnit)}${l.moq ? `, minimum order ${l.moq}${l.moqUnit ? ` ${l.moqUnit}` : ""}` : ""}, category ${l.category.name}${sellerName.get(l.sellerBusinessId) ? `, supplier ${sellerName.get(l.sellerBusinessId)}` : ""}`);
  }
  lines.push("", "## Top suppliers", "");
  for (const s of sellers) {
    lines.push(`- [${s.name}](${absoluteUrl(sellerPath(s.businessId))}): ${[s.city, s.state].filter(Boolean).join(", ") || "India"}, verification tier ${s.verificationTier}, trust score ${s.trustScore}/100`);
  }
  lines.push("", `_${SITE_TAGLINE}. Generated from live catalogue data; refreshed hourly._`, "");
  return lines.join("\n");
}
