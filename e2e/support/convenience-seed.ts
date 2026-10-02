/**
 * Test-data helper for e2e/a11y/buyer-convenience.spec.ts. Run with tsx against the e2e database:
 *
 *   unlock <buyerEmail> <listingId>   an ACCEPTED match between the buyer and the listing's supplier, and a supplier that
 *                                     shares its contact (counterparty_sharing). Prints { phone } as JSON.
 *   save <buyerEmail> <listingId>     puts the listing in the buyer's default wishlist.
 *
 * The real flow (supplier accepts a lead and pays a credit) lives in the seller app and @cnote/enquiry and is covered by
 * their own tests; this only builds the resulting rows so the buyer-side UI can be checked.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(__dirname, "../..");
const req = createRequire(path.join(root, "packages/leadgen/package.json"));
const load = (spec: string) => import(pathToFileURL(req.resolve(spec)).href);

async function main() {
  const [cmd, email, listingId] = process.argv.slice(2);
  if (!cmd || !email || !listingId) throw new Error("usage: convenience-seed.ts <unlock|save> <buyerEmail> <listingId>");
  const { prisma } = await load("@cnote/db");
  const person = await prisma.person.findFirstOrThrow({ where: { email: email.toLowerCase() } });
  const listing = await prisma.listing.findUniqueOrThrow({ where: { id: listingId }, select: { sellerBusinessId: true } });

  if (cmd === "save") {
    const list =
      (await prisma.wishlist.findFirst({ where: { personId: person.id, isDefault: true } })) ??
      (await prisma.wishlist.create({ data: { personId: person.id, name: "Saved items", isDefault: true } }));
    await prisma.wishlistItem.upsert({
      where: { wishlistId_listingId: { wishlistId: list.id, listingId } },
      create: { wishlistId: list.id, listingId },
      update: {},
    });
    console.log(JSON.stringify({ listId: list.id }));
  } else if (cmd === "unlock") {
    const member = await prisma.businessMember.findFirstOrThrow({ where: { personId: person.id }, select: { businessId: true } });
    // The supplier's owner: use the existing one, or create one, with a unique phone and the sharing consent granted.
    let owner = await prisma.businessMember.findFirst({ where: { businessId: listing.sellerBusinessId, role: "owner" }, select: { personId: true } });
    const phone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    if (!owner) {
      const p = await prisma.person.create({ data: { email: `e2e-supplier-${Date.now()}@example.com`, name: "E2E Supplier" } });
      await prisma.businessMember.create({ data: { businessId: listing.sellerBusinessId, personId: p.id, role: "owner" } });
      owner = { personId: p.id };
    }
    await prisma.person.update({ where: { id: owner.personId }, data: { phone, phoneVerifiedAt: new Date(), email: (await prisma.person.findUniqueOrThrow({ where: { id: owner.personId } })).email ?? `e2e-supplier-${Date.now()}@example.com` } });
    await prisma.consent.create({ data: { personId: owner.personId, purpose: "counterparty_sharing", granted: true, source: "e2e" } });
    const enquiry = await prisma.enquiry.create({
      data: { buyerBusinessId: member.businessId, buyerPersonId: person.id, title: "E2E unlock enquiry", requirement: "Seeded by the e2e suite", status: "matched" },
    });
    await prisma.match.create({
      data: { enquiryId: enquiry.id, sellerBusinessId: listing.sellerBusinessId, rank: 1, matchScore: 0.9, status: "accepted", respondBy: new Date(Date.now() + 2 * 3600_000), respondedAt: new Date() },
    });
    console.log(JSON.stringify({ phone, enquiryId: enquiry.id }));
  } else throw new Error(`unknown command ${cmd}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
