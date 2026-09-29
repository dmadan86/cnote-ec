// Storefront slugs: /store/<slug> today, <slug>.<root> subdomains later, so they must be valid DNS labels.
import { DomainError } from "@cnote/core";

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** Hostnames/paths the platform owns; a seller can never claim them (also blocks lookalike subdomains). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www", "api", "admin", "app", "seller", "studio", "mail", "email", "smtp", "imap", "ftp", "store", "stores", "static", "cdn", "assets", "media", "img", "images",
  "dev", "staging", "test", "demo", "preview", "sandbox", "status", "support", "help", "docs", "blog", "news", "web", "dashboard", "console", "login", "signin",
  "signup", "register", "auth", "account", "accounts", "billing", "pricing", "checkout", "pay", "payments", "secure", "security", "root", "system", "cnote",
  "manufacturers", "products", "categories", "search", "rfq", "enquiry", "buyer", "sellers", "seller-app", "about", "contact", "terms", "privacy", "legal",
  "ns1", "ns2", "mx", "webmail", "vpn", "git", "ci", "internal", "official", "null", "undefined", "localhost",
]);

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type SlugProblem = "length" | "format" | "reserved";

export function slugProblem(slug: string): { code: SlugProblem; message: string } | null {
  if (slug.length < SLUG_MIN || slug.length > SLUG_MAX) return { code: "length", message: `Use ${SLUG_MIN} to ${SLUG_MAX} characters.` };
  if (!SLUG_RE.test(slug) || slug.includes("--")) return { code: "format", message: "Use lowercase letters, digits and single hyphens; start and end with a letter or digit." };
  if (RESERVED_SLUGS.has(slug)) return { code: "reserved", message: "That name is reserved. Please choose another." };
  return null;
}

export function assertValidSlug(slug: string): void {
  const p = slugProblem(slug);
  if (p) throw new DomainError("validation", p.message, { field: "slug", code: p.code });
}

/** "Sri Lakshmi Packaging Pvt. Ltd." → "sri-lakshmi-packaging". Always returns something valid (before uniqueness). */
export function suggestSlug(businessName: string): string {
  let s = businessName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|opc|pvt\.|ltd\.)\b\.?/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-+$/g, "");
  if (s.length < SLUG_MIN) s = `${s}-store`.replace(/^-+/, "");
  if (s.length < SLUG_MIN) s = "my-store";
  return RESERVED_SLUGS.has(s) ? `${s}-co` : s;
}
