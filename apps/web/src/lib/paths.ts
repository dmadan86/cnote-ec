const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

/** URL-safe lowercase slug (max 60 chars, word boundary friendly). Empty string when nothing usable remains. */
export function slugify(input: string, max = 60): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length > max ? s.slice(0, max).replace(/-[^-]*$/, "") || s.slice(0, max) : s;
}

/** Canonical product path: /p/<slug>-<uuid>. The uuid is the identity; the slug is cosmetic and self-healing. */
export const productPath = (l: { id: string; title: string }) => {
  const slug = slugify(l.title);
  return `/p/${slug ? `${slug}-` : ""}${l.id}`;
};

/** Splits "<slug>-<uuid>" (or a bare uuid) into its parts; null when the trailing 36 chars aren't a uuid. */
export function parseProductParam(param: string): { id: string; slug: string } | null {
  const decoded = decodeURIComponent(param);
  const id = decoded.slice(-36);
  if (!isUuid(id)) return null;
  const rest = decoded.slice(0, -36);
  if (rest && !rest.endsWith("-")) return null;
  return { id: id.toLowerCase(), slug: rest.replace(/-$/, "") };
}

export const categoryPath = (slug: string) => `/c/${slug}`;
export const sellerPath = (businessId: string) => `/manufacturers/${businessId}`;

/** Curated SEO landing page: /s/<category-slug>/<keyword-slug>. */
export const landingPath = (categorySlug: string, keyword: string) => `/s/${categorySlug}/${slugify(keyword, 50)}`;
