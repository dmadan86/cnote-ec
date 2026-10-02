import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { listSaversOfListing } from "../src";

const people: string[] = [];
const person = () => {
  const p = randomUUID();
  people.push(p);
  return p;
};
afterAll(async () => {
  await prisma.wishlist.deleteMany({ where: { personId: { in: people } } });
});

describe("listSaversOfListing", () => {
  it("returns each person once with the highest price they saw; malformed ids give nothing", async () => {
    const listingId = randomUUID();
    const a = person(), b = person(), c = person();
    const save = (personId: string, name: string, price: number | null) =>
      prisma.wishlist.create({ data: { personId, name, items: { create: { listingId, savedPricePaise: price === null ? null : BigInt(price) } } } });
    await save(a, "one", 100);
    await save(a, "two", 150);
    await save(b, "only", null);
    await save(c, "late", null);
    await prisma.wishlistItem.updateMany({ where: { wishlist: { personId: c } }, data: { savedPricePaise: 70n } });
    const out = await listSaversOfListing(listingId);
    expect(out.sort((x, y) => x.personId.localeCompare(y.personId))).toEqual(
      [{ personId: a, savedPricePaise: 150 }, { personId: b, savedPricePaise: null }, { personId: c, savedPricePaise: 70 }].sort((x, y) => x.personId.localeCompare(y.personId)),
    );
    expect(await listSaversOfListing("nope")).toEqual([]);
    expect(await listSaversOfListing(randomUUID())).toEqual([]);
  });

  it("a null price is replaced by a later known price for the same person", async () => {
    const listingId = randomUUID();
    const a = person();
    await prisma.wishlist.create({ data: { personId: a, name: "n1", items: { create: { listingId, savedPricePaise: null } } } });
    await prisma.wishlist.create({ data: { personId: a, name: "n2", items: { create: { listingId, savedPricePaise: 90n } } } });
    expect(await listSaversOfListing(listingId)).toEqual([{ personId: a, savedPricePaise: 90 }]);
  });
});
