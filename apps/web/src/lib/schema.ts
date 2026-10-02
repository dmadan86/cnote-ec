import type { ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";
import { DEFAULT_LOCALE, localizePath, type Locale } from "@/i18n/config";
import { absoluteUrl } from "./site-url";
import { productPath, sellerPath } from "./paths";

type Json = Record<string, unknown>;

/** Absolute URL of a public path in a locale (English is unprefixed). */
const localUrl = (path: string, locale: Locale) => absoluteUrl(localizePath(path, locale));

export const breadcrumbLd = (items: { name: string; path?: string }[]): Json => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, ...(it.path ? { item: absoluteUrl(it.path) } : {}) })),
});

/** ItemList of product URLs for category / landing / search pages (lets crawlers and LLMs enumerate the results). */
export const itemListLd = (name: string, listings: Pick<ListingView, "id" | "title">[], locale: Locale = DEFAULT_LOCALE): Json => ({
  "@context": "https://schema.org",
  "@type": "ItemList",
  name,
  numberOfItems: listings.length,
  itemListElement: listings.map((l, i) => ({ "@type": "ListItem", position: i + 1, url: localUrl(productPath(l), locale), name: l.title })),
});

const toImages = (l: ListingView) => l.imageUrls.filter((u) => !u.endsWith(".svg")).map((u) => absoluteUrl(u));

/**
 * schema.org Product + Offer. Price is INR (paise / 100). `rating` must come from APPROVED reviews only
 * (getRatingSummaries is approved-only by construction); it is omitted entirely when there are no reviews.
 */
export function productLd(l: ListingView, seller: TrustProfile | null, rating: { average: number; count: number } | null, reviews: { rating: number; author: string; body: string; date: string }[] = [], locale: Locale = DEFAULT_LOCALE): Json {
  const url = localUrl(productPath(l), locale);
  const images = toImages(l);
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#product`,
      name: l.title,
    description: l.description || undefined,
    url,
    ...(images.length ? { image: images } : {}),
    category: l.category.name,
    ...(l.hsn ? { additionalProperty: [{ "@type": "PropertyValue", name: "HSN code", value: l.hsn }] } : {}),
    ...(seller ? { brand: { "@type": "Brand", name: seller.name } } : {}),
    offers: {
      "@type": "Offer",
      url,
      priceCurrency: "INR",
      ...(l.pricePaise != null ? { price: (l.pricePaise / 100).toFixed(2) } : {}),
      availability: "https://schema.org/InStock",
      itemCondition: "https://schema.org/NewCondition",
      ...(l.moq != null ? { eligibleQuantity: { "@type": "QuantitativeValue", minValue: l.moq, ...(l.moqUnit ? { unitText: l.moqUnit } : {}) } } : {}),
      ...(seller
        ? { seller: { "@type": "Organization", name: seller.name, url: localUrl(sellerPath(seller.businessId), locale), ...(seller.city ? { address: { "@type": "PostalAddress", addressLocality: seller.city, ...(seller.state ? { addressRegion: seller.state } : {}), addressCountry: "IN" } } : {}) } }
        : {}),
    },
    ...(rating && rating.count > 0 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: rating.average, reviewCount: rating.count, bestRating: 5, worstRating: 1 } } : {}),
    ...(reviews.length
      ? { review: reviews.map((r) => ({ "@type": "Review", reviewRating: { "@type": "Rating", ratingValue: r.rating, bestRating: 5 }, author: { "@type": "Person", name: r.author }, reviewBody: r.body, datePublished: r.date })) }
      : {}),
  };
}

/** `rating` is the seller's approved-review aggregate; aggregateRating is emitted only when there are real reviews. */
export function sellerLd(s: TrustProfile, locale: Locale = DEFAULT_LOCALE, rating?: { average: number; count: number } | null, extra: { sameAs?: string[] } = {}): Json {
  const url = localUrl(sellerPath(s.businessId), locale);
  return {
    "@context": "https://schema.org",
    "@type": ["Organization", "LocalBusiness"],
    "@id": `${url}#org`,
      name: s.name,
    url,
    ...(s.city || s.state
      ? { address: { "@type": "PostalAddress", ...(s.city ? { addressLocality: s.city } : {}), ...(s.state ? { addressRegion: s.state } : {}), ...(s.pincode ? { postalCode: s.pincode } : {}), addressCountry: "IN" } }
      : {}),
    areaServed: { "@type": "Country", name: "India" },
    ...(s.languages.length ? { knowsLanguage: s.languages } : {}),
    ...(rating && rating.count > 0 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: rating.average, reviewCount: rating.count, bestRating: 5, worstRating: 1 } } : {}),
    ...(extra.sameAs?.length ? { sameAs: extra.sameAs } : {}),
    additionalProperty: [
      { "@type": "PropertyValue", name: "Trust score (0-100)", value: s.trustScore },
      { "@type": "PropertyValue", name: "Verification tier (0-3)", value: s.verificationTier },
    ],
  };
}

/**
 * FAQPage for a product's answered Q&A. Only approved questions with approved answers reach this (the module's public
 * list), so nothing held for moderation or private to its asker is ever exposed to crawlers.
 */
export const faqLd = (items: { question: string; answer: string; date?: string }[]): Json | null =>
  items.length === 0
    ? null
    : {
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map((i) => ({
          "@type": "Question",
          name: i.question,
          ...(i.date ? { dateCreated: i.date } : {}),
          acceptedAnswer: { "@type": "Answer", text: i.answer },
        })),
      };
