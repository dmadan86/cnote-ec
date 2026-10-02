import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  businesses: new Set<string>(),
  matches: [] as string[],
  searchFails: false,
  sellerListings: new Map<string, { id: string; title: string; createdAt: string; category: { id: string; slug: string }; pricePaise: number | null; priceUnit: string | null; seller?: { name: string } }[]>(),
  publicListings: new Map<string, { id: string; title: string; category: { id: string; slug: string } }>(),
  savers: new Map<string, { personId: string; savedPricePaise: number | null }[]>(),
  savedIds: [] as string[],
}));
vi.mock("@cnote/identity", () => ({
  getTrustProfiles: async (ids: string[]) => new Map(ids.filter((i) => h.businesses.has(i)).map((i) => [i, { businessId: i, name: `Biz ${i.slice(0, 4)}`, city: "Surat", state: "Gujarat", verificationTier: 2, badgeActive: true }])),
}));
vi.mock("@cnote/search", async (orig) => ({
  ...(await orig<typeof import("@cnote/search")>()),
  searchListings: async () => {
    if (h.searchFails) throw new Error("search down");
    return { hits: h.matches.map((id) => ({ listing: { id } })), tookMs: 1 };
  },
}));
vi.mock("@cnote/catalogue", () => ({
  listPublicSellerListings: async (id: string) => h.sellerListings.get(id) ?? [],
  getPublicListingsByIds: async (ids: string[]) => ids.flatMap((i) => (h.publicListings.has(i) ? [h.publicListings.get(i)] : [])),
}));
vi.mock("@cnote/wishlist", () => ({
  listSaversOfListing: async (id: string) => h.savers.get(id) ?? [],
  listSavedListingIds: async () => h.savedIds,
}));

import {
  alertUnsubscribeUrl, createSavedSearch, deleteSavedSearch, eraseAlertsData, exportAlertsData, followSupplier, getAlertSettings, isFollowing, listFollowedSuppliers, listSavedSearches,
  onListingPriceChanged, onListingPublished, purgeOldDispatches, runFollowedDigests, runSavedSearchDigests, setAlertSetting, setSearchFrequency, unfollowSupplier, unsubscribeByToken,
  countFollowers, signUnsubscribeToken, verifyUnsubscribeToken, worker,
} from "../src";

const people: string[] = [];
const newPerson = () => {
  const p = randomUUID();
  people.push(p);
  return p;
};
const biz = () => {
  const b = randomUUID();
  h.businesses.add(b);
  return b;
};
const events = async (personId: string, type = "BuyerAlertTriggered") =>
  (await prisma.domainEvent.findMany({ where: { type }, orderBy: { id: "asc" } })).map((e) => e.payload as Record<string, unknown>).filter((p) => p.personId === personId);
const evt = (payload: Record<string, unknown>, id = Math.floor(Math.random() * 1e9)) => ({ id, type: "x", version: 1, aggregateType: "x", aggregateId: "x", occurredAt: "", payload }) as never;
const DAY = 86_400_000;

beforeEach(() => {
  h.matches = [];
  h.searchFails = false;
  h.sellerListings.clear();
  h.publicListings.clear();
  h.savers.clear();
  h.savedIds = [];
});
afterAll(async () => {
  await prisma.supplierFollow.deleteMany({ where: { personId: { in: people } } });
  await prisma.savedSearch.deleteMany({ where: { personId: { in: people } } });
  await prisma.alertSettings.deleteMany({ where: { personId: { in: people } } });
  await prisma.alertDispatch.deleteMany({ where: { personId: { in: people } } });
});

describe("followed suppliers", () => {
  it("follow is idempotent, emits once, counts followers (aggregate only) and unfollow emits once", async () => {
    const p = newPerson(), p2 = newPerson(), b = biz();
    expect(await followSupplier(p, b)).toEqual({ following: true, created: true });
    expect(await followSupplier(p, b)).toEqual({ following: true, created: false });
    await followSupplier(p2, b);
    expect(await isFollowing(p, b)).toBe(true);
    expect(await countFollowers(b)).toBe(2);
    const ev = (await prisma.domainEvent.findMany({ where: { type: "SupplierFollowChanged", aggregateId: b } })).filter((e) => (e.payload as { personId: string }).personId === p);
    expect(ev).toHaveLength(1);
    expect(await unfollowSupplier(p, b)).toEqual({ following: false, removed: true });
    expect(await unfollowSupplier(p, b)).toEqual({ following: false, removed: false });
    expect(await isFollowing(p, b)).toBe(false);
    expect(await countFollowers(b)).toBe(1);
    await prisma.domainEvent.deleteMany({ where: { aggregateId: b } });
  });

  it("rejects unknown suppliers and malformed ids; unfollow of a malformed id is a no-op", async () => {
    const p = newPerson();
    await expect(followSupplier(p, "nope")).rejects.toMatchObject({ code: "not_found" });
    await expect(followSupplier(p, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    expect(await unfollowSupplier(p, "nope")).toEqual({ following: false, removed: false });
    expect(await isFollowing(p, "nope")).toBe(false);
    expect(await countFollowers("nope")).toBe(0);
  });

  it("lists followed suppliers with their newest listings", async () => {
    const p = newPerson(), b = biz();
    h.sellerListings.set(b, [1, 2, 3, 4].map((n) => ({ id: randomUUID(), title: `L${n}`, createdAt: new Date().toISOString(), category: { id: "c", slug: "c" }, pricePaise: 100, priceUnit: "kg" })));
    await followSupplier(p, b);
    const rows = await listFollowedSuppliers(p);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ businessId: b, name: expect.stringContaining("Biz"), verificationTier: 2 });
    expect(rows[0]!.latestListings).toHaveLength(3);
    expect(await listFollowedSuppliers(newPerson())).toEqual([]);
    await prisma.domainEvent.deleteMany({ where: { aggregateId: b } });
  });
});

describe("saved searches", () => {
  it("creates with a baseline, rejects duplicates and empty searches, and manages frequency", async () => {
    const p = newPerson();
    h.matches = [randomUUID(), randomUUID()];
    await expect(createSavedSearch(p, {})).rejects.toMatchObject({ code: "validation" });
    const s = await createSavedSearch(p, { query: "Cotton  Yarn", filters: { minTier: 2, states: ["Gujarat"] }, sort: "bogus" });
    expect(s).toMatchObject({ name: "Cotton  Yarn", frequency: "off", sort: "relevance", filters: { minTier: 2, states: ["gujarat"] } });
    const row = await prisma.savedSearch.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.seenListingIds).toEqual(h.matches);
    expect(row.lastRunAt).not.toBeNull();
    await expect(createSavedSearch(p, { query: "cotton yarn", filters: { states: ["gujarat"], minTier: 2 } })).rejects.toMatchObject({ code: "conflict" });
    const b = await createSavedSearch(p, { filters: { categories: ["yarn"] }, frequency: "weekly", name: "Yarn" });
    expect(b.frequency).toBe("weekly");
    expect((await listSavedSearches(p)).map((x) => x.name)).toEqual(["Yarn", "Cotton  Yarn"]);

    h.matches = [...h.matches, randomUUID()];
    const on = await setSearchFrequency(p, s.id, "daily");
    expect(on.frequency).toBe("daily");
    expect((await prisma.savedSearch.findUniqueOrThrow({ where: { id: s.id } })).seenListingIds).toHaveLength(3); // re-baselined on switch-on
    await expect(setSearchFrequency(p, s.id, "hourly" as never)).rejects.toMatchObject({ code: "validation" });
    expect((await setSearchFrequency(p, s.id, "off")).frequency).toBe("off");
    await expect(setSearchFrequency(newPerson(), s.id, "daily")).rejects.toMatchObject({ code: "not_found" });
    await deleteSavedSearch(p, s.id);
    await expect(deleteSavedSearch(p, s.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteSavedSearch(p, "bad")).rejects.toMatchObject({ code: "not_found" });
    expect(await listSavedSearches(p)).toHaveLength(1);
  });

  it("still saves when search is down (first digest run records the baseline silently) and caps the number of searches", async () => {
    const p = newPerson();
    h.searchFails = true;
    const s = await createSavedSearch(p, { query: "boxes" });
    expect((await prisma.savedSearch.findUniqueOrThrow({ where: { id: s.id } })).lastRunAt).toBeNull();
    for (let i = 0; i < 19; i++) await createSavedSearch(p, { query: `q${i}` });
    await expect(createSavedSearch(p, { query: "one too many" })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("saved-search digest job", () => {
  const mk = async (p: string, frequency: "daily" | "weekly", over: { lastRunAt?: Date | null; seen?: string[] } = {}) => {
    const s = await createSavedSearch(p, { query: `q-${randomUUID()}`, frequency });
    await prisma.savedSearch.update({ where: { id: s.id }, data: { lastRunAt: over.lastRunAt === undefined ? new Date(Date.now() - 8 * DAY) : over.lastRunAt, seenListingIds: over.seen ?? [] } });
    return s.id;
  };

  it("reports only NEW listings, advances the cursor and is idempotent", async () => {
    const p = newPerson();
    const old = randomUUID(), fresh1 = randomUUID(), fresh2 = randomUUID();
    const id = await mk(p, "weekly", { seen: [old] });
    h.matches = [fresh1, fresh2, old];
    expect(await runSavedSearchDigests(new Date(), 500)).toBeGreaterThanOrEqual(1);
    const ev = (await events(p)).filter((e) => e.subjectId === id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ alertType: "saved_search", count: 2, href: "/account/saved-searches" });
    expect(await runSavedSearchDigests(new Date(), 500)).toBe(0); // not due again and nothing new
    expect((await events(p)).filter((e) => e.subjectId === id)).toHaveLength(1);
    // due again, no new listings: cursor moves but nothing is sent
    await prisma.savedSearch.update({ where: { id }, data: { lastRunAt: new Date(Date.now() - 8 * DAY) } });
    await runSavedSearchDigests(new Date(), 500);
    expect((await events(p)).filter((e) => e.subjectId === id)).toHaveLength(1);
  });

  it("two concurrent runs emit once (compare-and-set on the cursor)", async () => {
    const p = newPerson();
    const id = await mk(p, "daily", { lastRunAt: new Date(Date.now() - 2 * DAY) });
    h.matches = [randomUUID()];
    await Promise.all([runSavedSearchDigests(new Date(), 500), runSavedSearchDigests(new Date(), 500)]);
    expect((await events(p)).filter((e) => e.subjectId === id)).toHaveLength(1);
  });

  it("skips off and not-yet-due searches, baselines silently when never run, and survives a failing search", async () => {
    const p = newPerson();
    const off = await createSavedSearch(p, { query: "off-one" });
    await prisma.savedSearch.update({ where: { id: off.id }, data: { lastRunAt: new Date(Date.now() - 9 * DAY) } });
    const notDue = await mk(p, "weekly", { lastRunAt: new Date(Date.now() - 2 * DAY) });
    const never = await mk(p, "daily", { lastRunAt: null });
    h.matches = [randomUUID()];
    await runSavedSearchDigests(new Date(), 500);
    expect((await events(p)).filter((e) => [off.id, notDue, never].includes(e.subjectId as string))).toHaveLength(0);
    expect((await prisma.savedSearch.findUniqueOrThrow({ where: { id: never } })).lastRunAt).not.toBeNull();
    const failing = await mk(p, "daily", { lastRunAt: new Date(Date.now() - 2 * DAY) });
    h.searchFails = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runSavedSearchDigests(new Date(), 500);
    expect((await prisma.savedSearch.findUniqueOrThrow({ where: { id: failing } })).lastRunAt!.getTime()).toBeLessThan(Date.now() - DAY); // retried next tick
  });
});

describe("followed-supplier digest job", () => {
  it("is opt-in, honours the weekly window and the buyer's categories, and is idempotent", async () => {
    const p = newPerson(), b = biz();
    await followSupplier(p, b);
    const mkL = (slug: string, ageDays: number) => ({ id: randomUUID(), title: slug, createdAt: new Date(Date.now() - ageDays * DAY).toISOString(), category: { id: `id-${slug}`, slug }, pricePaise: null, priceUnit: null });
    h.sellerListings.set(b, [mkL("yarn", 1), mkL("yarn", 2), mkL("boxes", 1), mkL("yarn", 30)]);
    expect(await runFollowedDigests(new Date(), 500)).toBe(0); // not opted in
    await setAlertSetting(p, "followed_digest", true);
    h.savedIds = [];
    h.publicListings.set("x", { id: "x", title: "x", category: { id: "id-yarn", slug: "yarn" } });
    h.savedIds = ["x"];
    // opting in starts the window now, so nothing is due yet
    expect(await runFollowedDigests(new Date(), 500)).toBe(0);
    await prisma.alertSettings.update({ where: { personId: p }, data: { followedDigestAt: new Date(Date.now() - 8 * DAY) } });
    await runFollowedDigests(new Date(), 500);
    const ev = await events(p);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ alertType: "followed_digest", count: 2, href: "/buyer/suppliers" }); // yarn only, within 8 days
    await runFollowedDigests(new Date(), 500);
    expect(await events(p)).toHaveLength(1);
    await prisma.domainEvent.deleteMany({ where: { aggregateId: b } });
  });

  it("without known categories every followed listing counts; opt-out stops it", async () => {
    const p = newPerson(), b = biz();
    await followSupplier(p, b);
    h.sellerListings.set(b, [{ id: randomUUID(), title: "t", createdAt: new Date().toISOString(), category: { id: "c1", slug: "c1" }, pricePaise: null, priceUnit: null, seller: { name: "Sharma" } }]);
    await setAlertSetting(p, "followed_digest", true);
    await prisma.alertSettings.update({ where: { personId: p }, data: { followedDigestAt: new Date(Date.now() - 8 * DAY) } });
    await runFollowedDigests(new Date(), 500);
    expect((await events(p))[0]).toMatchObject({ count: 1, label: "Sharma" });
    await setAlertSetting(p, "followed_digest", false);
    await prisma.alertSettings.update({ where: { personId: p }, data: { followedDigestAt: new Date(Date.now() - 8 * DAY) } });
    await runFollowedDigests(new Date(), 500);
    expect(await events(p)).toHaveLength(1);
    await prisma.domainEvent.deleteMany({ where: { aggregateId: b } });
  });
});

describe("price-drop and back-in-stock alerts", () => {
  const listing = (title = "Box") => {
    const id = randomUUID();
    h.publicListings.set(id, { id, title, category: { id: "c", slug: "c" } });
    return id;
  };

  it("alerts only opted-in savers, once per event, on a genuine drop", async () => {
    const yes = newPerson(), no = newPerson(), other = newPerson();
    const l = listing("Corrugated box");
    h.savers.set(l, [{ personId: yes, savedPricePaise: 15000 }, { personId: no, savedPricePaise: 15000 }, { personId: other, savedPricePaise: null }]);
    await setAlertSetting(yes, "price_drop", true);
    await setAlertSetting(other, "back_in_stock", true); // different type: must not receive price drops
    const e = evt({ listingId: l, sellerBusinessId: randomUUID(), fromPricePaise: 15000, toPricePaise: 12000, fromPriceUnit: "pcs", priceUnit: "pcs" }, 4242424);
    expect(await onListingPriceChanged(e)).toBe(1);
    expect(await onListingPriceChanged(e)).toBe(0); // redelivery
    expect(await events(yes)).toEqual([expect.objectContaining({ alertType: "price_drop", subjectId: l, label: "Corrugated box", fromPricePaise: 15000, toPricePaise: 12000, href: `/p/${l}` })]);
    expect(await events(no)).toEqual([]);
    expect(await events(other)).toEqual([]);
  });

  it("ignores raises, price-on-request, equal prices, unit changes, and listings that are not public", async () => {
    const p = newPerson();
    await setAlertSetting(p, "price_drop", true);
    const l = listing();
    h.savers.set(l, [{ personId: p, savedPricePaise: 100 }]);
    const base = { listingId: l, sellerBusinessId: randomUUID(), fromPriceUnit: "pcs", priceUnit: "pcs" };
    for (const [from, to, extra] of [[100, 120, {}], [null, 50, {}], [100, null, {}], [100, 100, {}], [100, 50, { fromPriceUnit: "kg" }]] as const) {
      expect(await onListingPriceChanged(evt({ ...base, fromPricePaise: from, toPricePaise: to, ...extra }))).toBe(0);
    }
    const gone = randomUUID();
    h.savers.set(gone, [{ personId: p, savedPricePaise: 100 }]);
    expect(await onListingPriceChanged(evt({ ...base, listingId: gone, fromPricePaise: 100, toPricePaise: 50 }))).toBe(0);
    expect(await onListingPriceChanged(evt({ ...base, listingId: randomUUID(), fromPricePaise: 100, toPricePaise: 50 }))).toBe(0); // no savers
    expect(await events(p)).toEqual([]);
  });

  it("back in stock reaches opted-in savers only", async () => {
    const yes = newPerson(), no = newPerson();
    const l = listing("Yarn");
    h.savers.set(l, [{ personId: yes, savedPricePaise: null }, { personId: no, savedPricePaise: null }]);
    await setAlertSetting(yes, "back_in_stock", true);
    const e = evt({ listingId: l, sellerBusinessId: randomUUID(), categoryId: "c" }, 5151515);
    expect(await onListingPublished(e)).toBe(1);
    expect(await onListingPublished(e)).toBe(0);
    expect(await events(yes)).toEqual([expect.objectContaining({ alertType: "back_in_stock", label: "Yarn", fromPricePaise: null })]);
    expect(await events(no)).toEqual([]);
  });

  it("wires the handlers on the module worker", async () => {
    const p = newPerson();
    await setAlertSetting(p, "back_in_stock", true);
    const l = listing("Wired");
    h.savers.set(l, [{ personId: p, savedPricePaise: null }]);
    await worker.handlers.ListingPublished!(evt({ listingId: l, sellerBusinessId: randomUUID(), categoryId: "c" }, 6161616) as never);
    expect(await events(p)).toHaveLength(1);
    expect(worker.jobs.map((j) => j.name)).toEqual(["alerts.saved-search-digests", "alerts.followed-digests"]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await Promise.all(worker.jobs.map((j) => j.run()));
  });
});

describe("settings, unsubscribe tokens and privacy", () => {
  it("every alert type defaults OFF and is toggled independently", async () => {
    const p = newPerson();
    expect(await getAlertSettings(p)).toEqual({ priceDrop: false, backInStock: false, followedDigest: false });
    expect(await setAlertSetting(p, "price_drop", true)).toEqual({ priceDrop: true, backInStock: false, followedDigest: false });
    expect(await setAlertSetting(p, "back_in_stock", true)).toMatchObject({ priceDrop: true, backInStock: true });
    await expect(setAlertSetting(p, "saved_search" as never, true)).rejects.toMatchObject({ code: "validation" });
  });

  it("one-click unsubscribe switches off exactly that type; forged tokens do nothing", async () => {
    const p = newPerson();
    await setAlertSetting(p, "price_drop", true);
    await setAlertSetting(p, "back_in_stock", true);
    const s = await createSavedSearch(p, { query: "x", frequency: "weekly" });
    const url = alertUnsubscribeUrl(p, "price_drop");
    expect(url).toMatch(/\/unsubscribe\/alerts\?t=/);
    const token = decodeURIComponent(url.split("t=")[1]!);
    expect(verifyUnsubscribeToken(token)).toEqual({ personId: p, type: "price_drop" });
    expect(await unsubscribeByToken(token)).toBe("price_drop");
    expect(await unsubscribeByToken(token)).toBe("price_drop"); // idempotent
    expect(await getAlertSettings(p)).toMatchObject({ priceDrop: false, backInStock: true });
    expect(await unsubscribeByToken(signUnsubscribeToken(p, "saved_search"))).toBe("saved_search");
    expect((await prisma.savedSearch.findUniqueOrThrow({ where: { id: s.id } })).frequency).toBe("off");
    for (const bad of ["", "a.b", `${token}x`, `${token}.extra`, "e30.AAAA", token.split(".")[0]!]) {
      expect(verifyUnsubscribeToken(bad)).toBeNull();
      expect(await unsubscribeByToken(bad)).toBeNull();
    }
    const body = Buffer.from(JSON.stringify({ p, t: "nope" })).toString("base64url");
    expect(verifyUnsubscribeToken(`${body}.${token.split(".")[1]}`)).toBeNull();
  });

  it("exports and erases everything about a person, leaving others untouched", async () => {
    const p = newPerson(), q = newPerson(), b = biz();
    await followSupplier(p, b);
    await followSupplier(q, b);
    await createSavedSearch(p, { query: "export me", frequency: "daily" });
    await createSavedSearch(q, { query: "keep me" });
    await setAlertSetting(p, "price_drop", true);
    await prisma.alertDispatch.create({ data: { personId: p, dedupeKey: `k-${randomUUID()}`, type: "price_drop" } });
    const out = await exportAlertsData(p) as { followedSuppliers: { businessId: string }[]; savedSearches: { query: string; frequency: string }[]; alertSettings: { priceDrop: boolean } };
    expect(out.followedSuppliers).toEqual([expect.objectContaining({ businessId: b })]);
    expect(out.savedSearches).toEqual([expect.objectContaining({ query: "export me", frequency: "daily" })]);
    expect(out.alertSettings.priceDrop).toBe(true);
    expect((await exportAlertsData(newPerson())).alertSettings).toBeNull();

    await worker.handlers.DataErasureRequested!(evt({ personId: p }) as never);
    await eraseAlertsData(p); // idempotent
    expect(await exportAlertsData(p)).toEqual({ followedSuppliers: [], savedSearches: [], alertSettings: null });
    expect(await prisma.alertDispatch.count({ where: { personId: p } })).toBe(0);
    expect(await isFollowing(q, b)).toBe(true);
    expect(await listSavedSearches(q)).toHaveLength(1);
    await prisma.domainEvent.deleteMany({ where: { aggregateId: b } });
  });

  it("purges only old dispatch rows (dry run counts without deleting)", async () => {
    const p = newPerson();
    const old = await prisma.alertDispatch.create({ data: { personId: p, dedupeKey: `old-${randomUUID()}`, type: "price_drop", createdAt: new Date(Date.now() - 120 * DAY) } });
    const fresh = await prisma.alertDispatch.create({ data: { personId: p, dedupeKey: `new-${randomUUID()}`, type: "price_drop" } });
    const cutoff = new Date(Date.now() - 90 * DAY);
    expect(await purgeOldDispatches(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await prisma.alertDispatch.count({ where: { id: old.id } })).toBe(1);
    expect(await purgeOldDispatches(cutoff)).toBeGreaterThanOrEqual(1);
    expect(await prisma.alertDispatch.count({ where: { id: old.id } })).toBe(0);
    expect(await prisma.alertDispatch.count({ where: { id: fresh.id } })).toBe(1);
  });
});
