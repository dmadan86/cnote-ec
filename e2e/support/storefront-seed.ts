/**
 * Test-data helper for e2e/a11y/storefront-embed.spec.ts. Run with tsx against the e2e database:
 *
 *   storefront-seed.ts <slug>
 *
 * Creates a seller business with a LIVE storefront whose home page has a YouTube video block and a map block (the two third-party
 * embeds), straight in the isolated `cnote_e2e` database, and prints { slug } as JSON. The real flow (Studio editor, AI pre-screen,
 * publish) lives in apps/studio and @cnote/storefront and has its own tests; this only builds the resulting rows so the buyer-web
 * rendering, the consent gate and the CSP can be checked in a real browser. Guarded like prepare-db: refuses non `_e2e` databases.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(__dirname, "../..");
const req = createRequire(path.join(root, "apps/web/package.json"));
const load = (spec: string) => import(pathToFileURL(req.resolve(spec)).href);

async function main() {
  const slug = process.argv[2];
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) throw new Error("usage: storefront-seed.ts <slug> (3-40 chars: a-z, 0-9, hyphens)");
  if (!/_e2e$/.test(new URL(process.env.DATABASE_URL ?? "").pathname.slice(1))) throw new Error("refusing to touch a database that does not end in _e2e");
  const { prisma } = await load("@cnote/db");
  const { blankDocument } = await load("@cnote/storefront/document");

  const business = await prisma.business.create({ data: { name: `E2E Embeds ${slug}`, isSeller: true, city: "Pune", state: "Maharashtra" } });
  const doc = blankDocument({ name: business.name, city: "Pune" });
  doc.pages[0].sections.push(
    { id: "video", type: "embed", tone: "default", title: "Factory tour", source: { kind: "youtube", videoId: "dQw4w9WgXcQ" } },
    { id: "map", type: "embed", tone: "surface", title: "Find our workshop", source: { kind: "map", lat: 18.5204, lng: 73.8567, zoom: 14 } },
  );
  const sf = await prisma.storefront.create({ data: { sellerBusinessId: business.id, slug, status: "live" } });
  const version = await prisma.storefrontVersion.create({ data: { storefrontId: sf.id, version: 1, document: doc, status: "published", publishedAt: new Date() } });
  await prisma.storefront.update({ where: { id: sf.id }, data: { publishedVersionId: version.id } });
  // Embed moderation (docs/design/storefront-embed-moderation.md): a video is shown only once its review row is approved (fail closed),
  // so the seed records the staff decision the real flow would produce. Maps carry no review.
  await prisma.storefrontEmbedReview.create({
    data: { storefrontId: sf.id, provider: "youtube", mediaId: "dQw4w9WgXcQ", status: "approved", title: "Factory tour", decidedBy: "staff", reviewedAt: new Date(), checkedAt: new Date() },
  });
  console.log(JSON.stringify({ slug }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
