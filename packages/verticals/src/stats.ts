import { getPublicListingsByIds, listCategories, listPublicListingIndex } from "@cnote/catalogue";
import { getTrustProfiles } from "@cnote/identity";

/**
 * Port for the seller-count aggregate (ADR-016 gate input). The default implementation composes existing public
 * functions of catalogue/identity (no cross-module table reads). It pages the whole live index, so a dedicated
 * aggregate in catalogue would be cheaper; swap it in with `setVerticalStatsPort` (see docs/design/verticals.md).
 */
export interface VerticalStatsPort {
  /**
   * Count distinct sellers with verificationTier >= minTier that have at least one live (published, approved) listing
   * in any of `categorySlugs` or their descendants.
   */
  countVerifiedSellers(categorySlugs: string[], minTier: number): Promise<number>;
}

const PAGE = 5000;
const CHUNK = 200;

/** Category slugs plus all descendants (categories form a tree via parentId). */
export async function expandCategorySlugs(roots: string[]): Promise<Set<string>> {
  const all = await listCategories();
  const byParent = new Map<string, typeof all>();
  for (const c of all) if (c.parentId) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  const out = new Set<string>();
  const visit = (id: string, slug: string) => {
    if (out.has(slug)) return;
    out.add(slug);
    for (const child of byParent.get(id) ?? []) visit(child.id, child.slug);
  };
  for (const r of roots) {
    const c = all.find((x) => x.slug === r);
    if (c) visit(c.id, c.slug);
    else out.add(r); // unknown slug: keep as-is so a not-yet-seeded category simply matches nothing
  }
  return out;
}

export const defaultStatsPort: VerticalStatsPort = {
  async countVerifiedSellers(categorySlugs, minTier) {
    const slugs = await expandCategorySlugs(categorySlugs);
    const listingIds: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page = await listPublicListingIndex({ offset, limit: PAGE });
      for (const e of page) if (slugs.has(e.categorySlug)) listingIds.push(e.id);
      if (page.length < PAGE) break;
    }
    const sellers = new Set<string>();
    for (let i = 0; i < listingIds.length; i += CHUNK) {
      for (const l of await getPublicListingsByIds(listingIds.slice(i, i + CHUNK))) sellers.add(l.sellerBusinessId);
    }
    const ids = [...sellers];
    let n = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      for (const p of (await getTrustProfiles(ids.slice(i, i + CHUNK))).values()) if (p.verificationTier >= minTier) n++;
    }
    return n;
  },
};

let port: VerticalStatsPort = defaultStatsPort;
export const setVerticalStatsPort = (p: VerticalStatsPort | null): void => void (port = p ?? defaultStatsPort);
export const getVerticalStatsPort = (): VerticalStatsPort => port;
