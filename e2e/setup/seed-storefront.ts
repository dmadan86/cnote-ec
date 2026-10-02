/**
 * Publishes one live storefront (/store/e2e-showcase) for the buyer-web a11y scan: a seeded seller, the first starter
 * template merged with the seller's details, status "live" with a published version (what staff approval would leave).
 * Same loader pattern as backfill-live.ts. Idempotent. Fictional test data in the isolated e2e databases.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const E2E_STOREFRONT_SLUG = "e2e-showcase";

const req = createRequire(path.resolve(__dirname, "../../apps/worker/package.json"));
const load = <T>(id: string) => import(pathToFileURL(req.resolve(id)).href) as Promise<T>;

type Doc = unknown;
async function main() {
  const { prisma } = await load<{ prisma: any }>("@cnote/db"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const sf = await load<{ TEMPLATE_SEEDS: { document: Doc }[]; mergeSellerData(d: Doc, s: { name: string; city: string | null }): Doc; validateDocumentClamped(d: Doc): { ok: boolean; document?: Doc } }>("@cnote/storefront");
  const seller = await prisma.business.findFirst({ where: { isSeller: true, listings: { some: {} } }, orderBy: { id: "asc" }, select: { id: true, name: true, city: true } }).catch(() => null)
    ?? (await prisma.business.findFirst({ where: { isSeller: true }, orderBy: { id: "asc" }, select: { id: true, name: true, city: true } }));
  if (!seller) throw new Error("no seeded seller");
  const v = sf.validateDocumentClamped(sf.mergeSellerData(sf.TEMPLATE_SEEDS[0]!.document, seller));
  if (!v.ok) throw new Error("template document invalid");
  const existing = await prisma.storefront.findUnique({ where: { slug: E2E_STOREFRONT_SLUG } });
  const row = existing ?? (await prisma.storefront.create({ data: { sellerBusinessId: seller.id, slug: E2E_STOREFRONT_SLUG, status: "live" } }));
  if (!existing) {
    const ver = await prisma.storefrontVersion.create({ data: { storefrontId: row.id, version: 1, document: v.document, status: "published", publishedAt: new Date() } });
    await prisma.storefront.update({ where: { id: row.id }, data: { publishedVersionId: ver.id, status: "live" } });
  }
  console.log(`[e2e] storefront /store/${E2E_STOREFRONT_SLUG} live for ${seller.name}`);
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
