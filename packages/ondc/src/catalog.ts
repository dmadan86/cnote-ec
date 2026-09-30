// Catalogue projection + publish (ADR-017). Nothing is published while ONDC_ENABLED is off.
import { emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { loadConfig, type OndcConfig } from "./config";
import { applyIntent, buildCatalog, buildProvider, providerHash, type BecknProvider, type SearchIntent } from "./mapping";
import { isKilled } from "./killswitch";
import { getSource } from "./source";

/** The provider node for one connected seller (null when disabled/not connected/nothing publishable). */
export async function providerFor(sellerBusinessId: string, cfg: OndcConfig = loadConfig()): Promise<BecknProvider | null> {
  if (!cfg.enabled || !/^[0-9a-f-]{36}$/i.test(sellerBusinessId)) return null;
  const seller = await prisma.ondcSeller.findUnique({ where: { businessId: sellerBusinessId } });
  if (!seller?.enabled) return null;
  const [listings, opts] = await Promise.all([
    getSource().live(sellerBusinessId),
    prisma.ondcListingOptIn.findMany({ where: { sellerBusinessId } }),
  ]);
  return buildProvider({ sellerBusinessId, listings, optIns: new Map(opts.map((o) => [o.listingId, o.ondcCategoryId])), categoryMap: cfg.categoryMap });
}

const MAX_PROVIDERS = 200;

export async function allProviders(cfg: OndcConfig = loadConfig()): Promise<BecknProvider[]> {
  if (!cfg.enabled || (await isKilled())) return [];
  const sellers = await prisma.ondcSeller.findMany({ where: { enabled: true }, orderBy: { createdAt: "asc" }, take: MAX_PROVIDERS, select: { businessId: true } });
  const out: BecknProvider[] = [];
  for (const s of sellers) {
    const p = await providerFor(s.businessId, cfg);
    if (p) out.push(p);
  }
  return out;
}

/** The on_search `catalog` for an intent, or null when nothing matches. */
export async function catalogForIntent(intent: SearchIntent, cfg: OndcConfig = loadConfig()) {
  const providers = applyIntent(await allProviders(cfg), intent);
  return providers.length ? buildCatalog(cfg.subscriberId, providers) : null;
}

export interface PublishResult { published: boolean; items: number; skipped?: "disabled" | "not_connected" | "unchanged" }

/**
 * Recomputes the seller's projection; when it changed since the last publish, records it and emits
 * OndcCatalogPublished in the same transaction. Idempotent (an unchanged catalogue emits nothing).
 */
export async function publishCatalog(sellerBusinessId: string, cfg: OndcConfig = loadConfig()): Promise<PublishResult> {
  if (!cfg.enabled || (await isKilled())) return { published: false, items: 0, skipped: "disabled" };
  const seller = await prisma.ondcSeller.findUnique({ where: { businessId: sellerBusinessId } });
  if (!seller) return { published: false, items: 0, skipped: "not_connected" };
  const provider = await providerFor(sellerBusinessId, cfg);
  const hash = providerHash(provider);
  const items = provider?.items.length ?? 0;
  if (seller.lastPublishedHash === hash) return { published: false, items, skipped: "unchanged" };
  await prisma.$transaction(async (tx) => {
    // compare-and-set: two concurrent publishers cannot both emit for the same change
    const res = await tx.ondcSeller.updateMany({
      where: { id: seller.id, lastPublishedHash: seller.lastPublishedHash },
      data: { lastPublishedHash: hash, lastPublishedAt: new Date(), publishedItems: items },
    });
    if (res.count === 1) await emit(tx, "OndcCatalogPublished", { type: "ondc_seller", id: seller.id }, { sellerBusinessId, providerId: sellerBusinessId, items });
  });
  return { published: true, items };
}

export async function publishAllCatalogs(cfg: OndcConfig = loadConfig()): Promise<number> {
  if (!cfg.enabled || (await isKilled())) return 0;
  let n = 0;
  const sellers = await prisma.ondcSeller.findMany({ select: { businessId: true } });
  for (const s of sellers) if ((await publishCatalog(s.businessId, cfg)).published) n++;
  return n;
}
