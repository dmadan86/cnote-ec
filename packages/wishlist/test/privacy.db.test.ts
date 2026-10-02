import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportPersonalData } from "../src";

const personId = randomUUID();
let made = false;
afterAll(async () => {
  if (made) {
    await prisma.wishlist.deleteMany({ where: { personId } });
    await prisma.person.deleteMany({ where: { id: personId } });
  }
});

describe("exportPersonalData (DPDP access right)", () => {
  it("exports lists with their items and notes; BigInt paise stay exact; share tokens never leave", async () => {
    await prisma.person.create({ data: { id: personId, email: `wl-${personId}@example.test` } });
    made = true;
    const wl = await prisma.wishlist.create({ data: { personId, name: "Project A", isDefault: false } });
    await prisma.wishlistItem.create({ data: { wishlistId: wl.id, listingId: randomUUID(), note: "5-ply", savedPricePaise: 4_200n } });
    await prisma.wishlistShare.create({ data: { wishlistId: wl.id, token: `tok-${randomUUID()}` } });
    const out = (await exportPersonalData(personId)) as { wishlists: { items: any[]; truncated: boolean } };
    expect(out.wishlists.truncated).toBe(false);
    expect(out.wishlists.items).toHaveLength(1);
    expect(out.wishlists.items[0]).toMatchObject({ name: "Project A", publicShareLinkActive: true });
    expect(out.wishlists.items[0].items[0]).toMatchObject({ note: "5-ply", savedPricePaise: 4_200n });
    expect(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).not.toContain("tok-");
  });
  it("is empty for a person with no lists", async () => {
    expect(await exportPersonalData(randomUUID())).toEqual({ wishlists: { items: [], truncated: false } });
  });
});
