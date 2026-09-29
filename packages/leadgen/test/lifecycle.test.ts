import fc from "fast-check";
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { hashPhone } from "@cnote/identity";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const enq = vi.hoisted(() => ({ calls: [] as { ctx: any; input: any; opts: any }[], fail: false }));
// Unlocks only see LIVE (published) listings; tests register the live projection of the listings they create.
const live = vi.hoisted(() => new Map<string, { title: string; category: { slug: string } }>());
vi.mock("@cnote/catalogue", async (orig) => ({
  ...(await orig<typeof import("@cnote/catalogue")>()),
  getPublicListing: async (id: string) => live.get(id) ?? null,
}));

vi.mock("@cnote/enquiry", () => ({
  createEnquiry: async (ctx: unknown, input: unknown, opts: unknown) => {
    if (enq.fail) throw new Error("enquiry down");
    enq.calls.push({ ctx, input, opts });
    return { id: "00000000-0000-4000-8000-0000000000aa" };
  },
}));

import {
  ABANDON_AFTER_MS, TRIGGERS, UNLOCKS, completeUnlock, funnelByTriggerDay, getCapture, markConverted, markOtpSent, markVerified, startCapture,
  startCaptureSchema, sweepAbandoned, unlockDetailsSchema, worker,
} from "../src";

const vid = () => `vid_${randomUUID().replace(/-/g, "")}`;
const capIds: string[] = [];
const personIds: string[] = [];
const bizIds: string[] = [];
const listingIds: string[] = [];
const phone = () => `+9190${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function person(opts: { verified?: boolean; erased?: boolean; withBusiness?: boolean; phone?: string } = {}) {
  const { verified = true, erased = false, withBusiness = true } = opts;
  const p = await prisma.person.create({
    data: { phone: opts.phone ?? (verified ? phone() : null), phoneVerifiedAt: verified ? new Date() : null, erasedAt: erased ? new Date() : null },
  });
  personIds.push(p.id);
  if (withBusiness) {
    const b = await prisma.business.create({ data: { name: `lg2-${p.id}` } });
    bizIds.push(b.id);
    await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  }
  return p;
}
const start = async (o: Partial<Parameters<typeof startCapture>[0]> = {}, personId?: string) => {
  const { captureId } = await startCapture({ visitorId: vid(), trigger: "pdp_best_price", unlock: "enquiry", ...o }, personId);
  capIds.push(captureId);
  return captureId;
};
const row = (id: string) => prisma.leadCapture.findUniqueOrThrow({ where: { id } });
const events = async (id: string) => (await prisma.domainEvent.findMany({ where: { aggregateId: id }, select: { type: true } })).map((e) => e.type).sort();

afterEach(() => {
  enq.calls.length = 0;
  enq.fail = false;
  vi.restoreAllMocks();
});
afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${capIds}) OR aggregate_id = ANY(${personIds})`;
  await prisma.leadCapture.deleteMany({ where: { id: { in: capIds } } });
  await prisma.listing.deleteMany({ where: { id: { in: listingIds } } });
  const owned = (await prisma.businessMember.findMany({ where: { personId: { in: personIds } }, select: { businessId: true } })).map((m) => m.businessId);
  await prisma.businessMember.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.business.deleteMany({ where: { id: { in: [...bizIds, ...owned] } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("input schemas", () => {
  it("startCaptureSchema validates visitorId, trigger, unlock, listingId, attribution and defaults", () => {
    const ok = { visitorId: "abcdefgh", trigger: "pdp_best_price", unlock: "enquiry" };
    const parsed = startCaptureSchema.parse(ok);
    expect(parsed).toMatchObject({ followUpConsent: false, attribution: {} });
    for (const bad of [
      { ...ok, visitorId: "short" }, { ...ok, visitorId: "has space!" }, { ...ok, visitorId: "x".repeat(65) }, { ...ok, trigger: "nope" },
      { ...ok, unlock: "nope" }, { ...ok, listingId: "not-uuid" }, { ...ok, attribution: { device: "fridge" } }, { ...ok, attribution: { utm_source: "x".repeat(101) } },
      { ...ok, followUpConsent: "yes" },
    ]) expect(startCaptureSchema.safeParse(bad).success).toBe(false);
    expect(startCaptureSchema.safeParse({ ...ok, listingId: null }).success).toBe(true);
    expect(startCaptureSchema.parse({ ...ok, visitorId: "  abcdefgh  " }).visitorId).toBe("abcdefgh");
  });
  it("every trigger x unlock pair is accepted (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TRIGGERS), fc.constantFrom(...UNLOCKS), fc.stringMatching(/^[A-Za-z0-9_-]{8,64}$/), (trigger, unlock, visitorId) =>
        startCaptureSchema.safeParse({ visitorId, trigger, unlock }).success),
    );
  });
  it("unlockDetailsSchema bounds", () => {
    expect(unlockDetailsSchema.parse(undefined)).toEqual({});
    for (const bad of [{ quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 2_000_000_001 }, { message: "x".repeat(1001) }, { deliveryPincode: "012345" }, { deliveryPincode: "12345" }, { quantityUnit: "x".repeat(21) }])
      expect(unlockDetailsSchema.safeParse(bad).success).toBe(false);
    expect(unlockDetailsSchema.safeParse({ quantity: 2_000_000_000, deliveryPincode: "110001", message: "  hi  " }).success).toBe(true);
    expect(unlockDetailsSchema.safeParse({ quantity: null, quantityUnit: null, message: null, deliveryPincode: null, deliveryCity: null }).success).toBe(true);
  });
});

describe("startCapture", () => {
  it("stores no phone, starts as 'started', and rejects invalid input", async () => {
    const id = await start({ attribution: { utm_source: "g", device: "mobile" }, followUpConsent: true });
    const r = await row(id);
    expect(r).toMatchObject({ status: "started", phoneHash: null, personId: null, followUpConsent: true, listingId: null, enquiryId: null });
    expect(r.attribution).toEqual({ utm_source: "g", device: "mobile" });
    await expect(startCapture({ visitorId: "x", trigger: "pdp_best_price", unlock: "enquiry" })).rejects.toThrow();
  });
  it("links person when given and drops an unknown listingId", async () => {
    const p = await person();
    const id = await start({ listingId: randomUUID() }, p.id);
    expect(await row(id)).toMatchObject({ personId: p.id, listingId: null, sellerBusinessId: null, categoryId: null });
  });
  it("copies seller + category from a real listing", async () => {
    const seller = await prisma.business.create({ data: { name: `lg2-seller-${randomUUID()}` } });
    bizIds.push(seller.id);
    const cat = await prisma.category.create({ data: { slug: `lg2-${randomUUID()}`, name: "c" } });
    const listing = await prisma.listing.create({ data: { sellerBusinessId: seller.id, categoryId: cat.id, title: "Steel Pipe" } });
    listingIds.push(listing.id);
    live.set(listing.id, { title: "Steel Pipe", category: { slug: cat.slug } });
    const id = await start({ listingId: listing.id });
    expect(await row(id)).toMatchObject({ listingId: listing.id, sellerBusinessId: seller.id, categoryId: cat.id });

    // completeUnlock uses the listing title + category slug for the enquiry
    const p = await person();
    await markVerified(id, p.id, false);
    const res = await completeUnlock(p.id, id, { message: "urgent", quantity: 5, quantityUnit: "kg", deliveryPincode: "110001", deliveryCity: "Delhi" });
    expect(res).toMatchObject({ kind: "enquiry" });
    const call = enq.calls[0]!;
    expect(call.input).toMatchObject({
      title: "Best price for Steel Pipe", categorySlug: cat.slug, quantity: 5, quantityUnit: "kg", deliveryPincode: "110001", deliveryCity: "Delhi",
      preferredListingId: listing.id,
    });
    expect(call.input.requirement).toBe("urgent\n\nI am interested in Steel Pipe. Please share your best price for 5 kg.");
    expect(call.opts).toEqual({ buyerPhoneVerified: true });
    expect(call.ctx.personId).toBe(p.id);
    await prisma.category.delete({ where: { id: cat.id } }).catch(() => undefined);
  });
});

describe("markOtpSent", () => {
  it("stores only sha256(phone), allows resend and resurrection from abandoned, updates consent only when given", async () => {
    const ph = phone();
    const id = await start({ followUpConsent: true });
    await markOtpSent(id, ph);
    let r = await row(id);
    expect(r.phoneHash).toBe(hashPhone(ph));
    expect(r.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r)).not.toContain(ph.slice(3));
    expect(r.followUpConsent).toBe(true); // untouched when undefined
    await markOtpSent(id, ph, false);
    expect((await row(id)).followUpConsent).toBe(false);
    await prisma.leadCapture.update({ where: { id }, data: { status: "abandoned" } });
    await markOtpSent(id, ph);
    r = await row(id);
    expect(r.status).toBe("otp_sent");
  });
  it("different phones hash differently; same phone hashes identically", () => {
    fc.assert(fc.property(fc.stringMatching(/^\+91[6-9]\d{9}$/), fc.stringMatching(/^\+91[6-9]\d{9}$/), (a, b) => (hashPhone(a) === hashPhone(b)) === (a === b)));
  });
  it("cannot move backwards from verified/converted, and unknown capture is not_found", async () => {
    const p = await person();
    const id = await start();
    await markVerified(id, p.id, false);
    await expect(markOtpSent(id, phone())).rejects.toMatchObject({ code: "not_found" });
    expect((await row(id)).status).toBe("verified");
    await markConverted(id, p.id, null);
    await expect(markOtpSent(id, phone())).rejects.toMatchObject({ code: "not_found" });
    expect((await row(id)).status).toBe("converted");
    await expect(markOtpSent(randomUUID(), phone())).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("markVerified", () => {
  it("unknown capture -> not_found; phone mismatch -> validation; other person's capture -> forbidden", async () => {
    const p = await person();
    await expect(markVerified(randomUUID(), p.id, true)).rejects.toMatchObject({ code: "not_found" });
    const ph = phone();
    const id = await start();
    await markOtpSent(id, ph);
    await expect(markVerified(id, p.id, true, phone())).rejects.toMatchObject({ code: "validation" });
    expect((await row(id)).status).toBe("otp_sent");
    expect(await events(id)).toEqual([]);
    await markVerified(id, p.id, true, ph);
    const other = await person();
    await expect(markVerified(id, other.id, true, ph)).rejects.toMatchObject({ code: "forbidden" });
    expect((await row(id)).personId).toBe(p.id);
  });
  it("without a recorded phone hash the phone check is skipped; verifying emits exactly one event (idempotent, also under concurrency)", async () => {
    const p = await person();
    const id = await start();
    await Promise.allSettled([markVerified(id, p.id, true, phone()), markVerified(id, p.id, true, phone()), markVerified(id, p.id, true)]);
    expect((await row(id)).status).toBe("verified");
    const ev = await events(id);
    expect(ev.filter((e) => e === "LeadCaptureVerified").length).toBeGreaterThanOrEqual(1);
    await markVerified(id, p.id, true);
    expect((await events(id)).length).toBe(ev.length);
    const payload = await prisma.domainEvent.findFirstOrThrow({ where: { aggregateId: id, type: "LeadCaptureVerified" } });
    expect(JSON.stringify(payload.payload)).not.toMatch(/\+91\d{10}/);
  });
  it("a capture pre-linked to a person can only be verified by that person", async () => {
    const owner = await person();
    const other = await person();
    const id = await start({}, owner.id);
    await expect(markVerified(id, other.id, false)).rejects.toMatchObject({ code: "forbidden" });
    await markVerified(id, owner.id, false);
  });
  it("an abandoned capture can still be verified (late OTP entry)", async () => {
    const p = await person();
    const id = await start();
    await prisma.leadCapture.update({ where: { id }, data: { status: "abandoned" } });
    await markVerified(id, p.id, false);
    expect((await row(id)).status).toBe("verified");
  });
});

describe("markConverted", () => {
  it("only converts verified captures owned by the person; emits once; other transitions are no-ops", async () => {
    const p = await person();
    const other = await person();
    const enquiryId = randomUUID();
    const id = await start();
    await markConverted(id, p.id, enquiryId); // started: no-op
    expect((await row(id)).status).toBe("started");
    await markOtpSent(id, phone());
    await markConverted(id, p.id, enquiryId);
    expect((await row(id)).status).toBe("otp_sent");
    await markVerified(id, p.id, false);
    await markConverted(id, other.id, enquiryId); // wrong person: no-op
    expect((await row(id)).status).toBe("verified");
    await markConverted(id, p.id, enquiryId);
    await markConverted(id, p.id, randomUUID()); // second call: no-op, enquiry unchanged
    const r = await row(id);
    expect(r).toMatchObject({ status: "converted", enquiryId });
    expect((await events(id)).filter((e) => e === "LeadCaptureConverted")).toHaveLength(1);
    expect(await getCapture(randomUUID())).toBeNull();
    expect((await getCapture(id))!.id).toBe(id);
  });
  it("abandoned captures cannot be converted", async () => {
    const p = await person();
    const id = await start({}, p.id);
    await prisma.leadCapture.update({ where: { id }, data: { status: "abandoned" } });
    await markConverted(id, p.id, null);
    expect((await row(id)).status).toBe("abandoned");
  });
});

describe("completeUnlock", () => {
  it("rejects unknown captures, other people's captures and unverified captures", async () => {
    const p = await person();
    await expect(completeUnlock(p.id, randomUUID())).rejects.toMatchObject({ code: "forbidden" });
    const id = await start({}, p.id);
    await expect(completeUnlock(p.id, id)).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/Verify/) });
    const other = await person();
    await expect(completeUnlock(other.id, id)).rejects.toMatchObject({ code: "forbidden" });
    expect(enq.calls).toHaveLength(0);
  });
  it("requires a verified, non-erased person with a verified phone", async () => {
    for (const opts of [{ verified: false }, { erased: true }]) {
      const p = await person(opts);
      const id = await start();
      await markVerified(id, p.id, false);
      await expect(completeUnlock(p.id, id)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(enq.calls).toHaveLength(0);
  });
  it("is idempotent for converted captures (returns the same enquiry, creates no new one)", async () => {
    const p = await person();
    const id = await start();
    await markVerified(id, p.id, false);
    const a = await completeUnlock(p.id, id);
    const b = await completeUnlock(p.id, id, { quantity: 99 });
    expect(a).toEqual(b);
    expect(enq.calls).toHaveLength(1);
    expect((a as { next: string }).next).toBe(`/buyer/enquiries/${(a as { enquiryId: string }).enquiryId}`);
  });
  it("quotes / save / catalogue unlocks convert without creating an enquiry", async () => {
    const p = await person();
    const q = await start({ unlock: "quotes" });
    await markVerified(q, p.id, false);
    expect(await completeUnlock(p.id, q)).toEqual({ kind: "quotes", next: "/rfq/new" });
    expect((await row(q)).status).toBe("converted");
    for (const unlock of ["save", "catalogue"] as const) {
      const id = await start({ unlock });
      await markVerified(id, p.id, false);
      expect(await completeUnlock(p.id, id)).toEqual({ kind: "none", next: "/buyer/enquiries" });
      expect((await row(id)).status).toBe("converted");
    }
    expect(enq.calls).toHaveLength(0);
  });
  it("seller_contact returns an in-app contact rule with no phone, and uses 'Contact request for'", async () => {
    const p = await person();
    const id = await start({ unlock: "seller_contact", trigger: "pdp_contact_seller" });
    await markVerified(id, p.id, false);
    const res = await completeUnlock(p.id, id);
    expect(res).toMatchObject({ kind: "seller_contact", contactRule: "in_app_after_match" });
    expect(JSON.stringify(res)).not.toMatch(/\+91\d{10}/);
    expect(enq.calls[0]!.input.title).toBe("Contact request for this product");
    expect(enq.calls[0]!.input.requirement).toBe("I am interested in this product. Please share your best price.");
  });
  it("creates a minimal buyer business for phone-only buyers (named from the last 4 digits) and reuses it after", async () => {
    const ph = "+919812345678";
    const p = await person({ withBusiness: false, phone: ph });
    const id = await start();
    await markVerified(id, p.id, true);
    await completeUnlock(p.id, id);
    const m = await prisma.businessMember.findFirstOrThrow({ where: { personId: p.id }, include: { business: true } });
    bizIds.push(m.businessId);
    expect(m.business.name).toBe("Buyer 5678");
    expect(enq.calls[0]!.ctx.businessId).toBe(m.businessId);
    const id2 = await start();
    await markVerified(id2, p.id, false);
    await completeUnlock(p.id, id2);
    expect(enq.calls[1]!.ctx.businessId).toBe(m.businessId);
    expect(await prisma.businessMember.count({ where: { personId: p.id } })).toBe(1);
  });
  it("names the buyer business after the person id when there is no phone on file", async () => {
    const p = await person({ withBusiness: false });
    await prisma.person.update({ where: { id: p.id }, data: { phone: null } });
    const id = await start();
    await markVerified(id, p.id, false);
    await completeUnlock(p.id, id);
    const m = await prisma.businessMember.findFirstOrThrow({ where: { personId: p.id }, include: { business: true } });
    bizIds.push(m.businessId);
    expect(m.business.name).toBe(`Buyer ${p.id.slice(0, 4)}`);
  });
  it("leaves the capture 'verified' (retryable) when enquiry creation fails, and validates details before side effects", async () => {
    const p = await person();
    const id = await start();
    await markVerified(id, p.id, false);
    await expect(completeUnlock(p.id, id, { quantity: -5 })).rejects.toThrow();
    enq.fail = true;
    await expect(completeUnlock(p.id, id)).rejects.toThrow("enquiry down");
    expect((await row(id)).status).toBe("verified");
    enq.fail = false;
    await expect(completeUnlock(p.id, id)).resolves.toMatchObject({ kind: "enquiry" });
  });
  it("truncates long titles/requirements to the enquiry limits", async () => {
    const seller = await prisma.business.create({ data: { name: `lg2-long-${randomUUID()}` } });
    bizIds.push(seller.id);
    const cat = await prisma.category.create({ data: { slug: `lg2-${randomUUID()}`, name: "c" } });
    const listing = await prisma.listing.create({ data: { sellerBusinessId: seller.id, categoryId: cat.id, title: "T".repeat(300) } });
    listingIds.push(listing.id);
    live.set(listing.id, { title: "T".repeat(300), category: { slug: cat.slug } });
    const p = await person();
    const id = await start({ listingId: listing.id });
    await markVerified(id, p.id, false);
    await completeUnlock(p.id, id, { message: "m".repeat(1000) });
    expect(enq.calls[0]!.input.title.length).toBe(140);
    expect(enq.calls[0]!.input.requirement.length).toBeLessThanOrEqual(4000);
    await prisma.leadCapture.deleteMany({ where: { listingId: listing.id } });
    await prisma.listing.delete({ where: { id: listing.id } });
    await prisma.category.delete({ where: { id: cat.id } });
  });
});

describe("sweepAbandoned", () => {
  const age = (ids: string[], at: Date) => prisma.leadCapture.updateMany({ where: { id: { in: ids } }, data: { updatedAt: at } });
  it("boundary: exactly 30 min old is kept, 30 min + 1ms is abandoned; only started/otp_sent are swept", async () => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - ABANDON_AFTER_MS);
    expect(ABANDON_AFTER_MS).toBe(30 * 60_000);
    const p = await person();
    const edge = await start();
    const past = await start();
    const otp = await start();
    await markOtpSent(otp, phone());
    const verified = await start();
    await markVerified(verified, p.id, false);
    const converted = await start();
    await markVerified(converted, p.id, false);
    await markConverted(converted, p.id, null);
    await age([edge], cutoff);
    await age([past, otp, verified, converted], new Date(cutoff.getTime() - 1));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const r = await sweepAbandoned(now);
    expect(r.abandoned).toBeGreaterThanOrEqual(2);
    expect((await row(edge)).status).toBe("started");
    expect((await row(past)).status).toBe("abandoned");
    expect((await row(otp)).status).toBe("abandoned");
    expect((await row(verified)).status).toBe("verified");
    expect((await row(converted)).status).toBe("converted");
    // sweeping again finds nothing new for these
    const again = await sweepAbandoned(now);
    expect(again.abandoned).toBeLessThan(r.abandoned + 1);
    expect((await row(edge)).status).toBe("started");
    // advancing the clock past the boundary sweeps the edge capture
    await sweepAbandoned(new Date(now.getTime() + 1));
    expect((await row(edge)).status).toBe("abandoned");
  });
  it("logs a follow-up intent only for consented captures with a phone hash, and never logs a phone", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const ph = phone();
    const consentedWithPhone = await start({ followUpConsent: true });
    await markOtpSent(consentedWithPhone, ph);
    const consentedNoPhone = await start({ followUpConsent: true });
    const noConsent = await start();
    await markOtpSent(noConsent, ph, false);
    const ids = [consentedWithPhone, consentedNoPhone, noConsent];
    await age(ids, new Date(Date.now() - 31 * 60_000));
    const r = await sweepAbandoned();
    expect(r.followUpsQueued).toBeGreaterThanOrEqual(1);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes(consentedWithPhone))).toBe(true);
    expect(lines.some((l) => l.includes(consentedNoPhone))).toBe(false);
    expect(lines.some((l) => l.includes(noConsent))).toBe(false);
    expect(lines.join("\n")).not.toContain(ph);
    expect(lines.join("\n")).not.toContain(hashPhone(ph));
    for (const id of ids) expect((await row(id)).status).toBe("abandoned");
  });
  it("does not abandon a capture that progressed between the read and the update", async () => {
    const p = await person();
    const id = await start();
    await markVerified(id, p.id, false);
    // the sweep's read still sees it as stale (simulated race); the status guard on the update protects it
    vi.spyOn(prisma.leadCapture, "findMany").mockResolvedValueOnce([{ id, followUpConsent: false, trigger: "pdp_best_price", phoneHash: null }] as never);
    const r = await sweepAbandoned();
    expect(r.abandoned).toBe(0);
    expect((await row(id)).status).toBe("verified");
  });
  it("the worker job runs the sweep", async () => {
    const id = await start();
    await age([id], new Date(Date.now() - 31 * 60_000));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(worker.name).toBe("leadgen");
    expect(worker.jobs).toHaveLength(1);
    await (worker.jobs![0]!.run as () => Promise<void>)();
    expect((await row(id)).status).toBe("abandoned");
  });
});

describe("funnelByTriggerDay", () => {
  // Set created_at via explicit timestamptz text: independent of the DB session time zone / driver Date handling.
  const setCreated = (id: string, iso: string) => prisma.$executeRaw`UPDATE lead_captures SET created_at = ${iso}::timestamptz WHERE id = ${id}::uuid`;
  it("counts cumulative stages per trigger/IST day and returns numbers", async () => {
    const trigger = "return_visit";
    const created = "2031-05-10T20:00:00Z"; // 01:30 IST on 05-11
    const mk = async (status: string, phoneHash: string | null = null) => {
      const id = await start({ trigger });
      await prisma.leadCapture.update({ where: { id }, data: { status: status as never, phoneHash } });
      await setCreated(id, created);
      return id;
    };
    await mk("started");
    await mk("started", "h1"); // phone hash recorded counts as reached otp step
    await mk("otp_sent", "h2");
    await mk("verified", "h3");
    await mk("converted", "h4");
    await mk("abandoned");
    const rows = await funnelByTriggerDay(new Date("2031-05-08T00:00:00Z"), new Date("2031-05-13T00:00:00Z"));
    const r = rows.find((x) => x.trigger === trigger)!;
    expect(r).toEqual({ day: "2031-05-11", trigger, started: 6, otpSent: 4, verified: 2, converted: 1, abandoned: 1 });
    expect(r.started >= r.otpSent && r.otpSent >= r.verified && r.verified >= r.converted).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/phone/i);
    // rows outside the requested range are excluded
    expect((await funnelByTriggerDay(new Date("2031-05-01T00:00:00Z"), new Date("2031-05-05T00:00:00Z"))).find((x) => x.trigger === trigger)).toBeUndefined();
    expect((await funnelByTriggerDay(new Date("2031-05-12T00:00:00Z"), new Date("2031-05-14T00:00:00Z"))).find((x) => x.trigger === trigger)).toBeUndefined();
  });
  it("orders by day desc then trigger and separates IST days", async () => {
    const t = async (trigger: "exit_intent" | "wishlist", at: string) => {
      const id = await start({ trigger });
      await setCreated(id, at);
    };
    await t("wishlist", "2032-01-01T18:29:00Z"); // 23:59 IST Jan 1
    await t("exit_intent", "2032-01-01T18:31:00Z"); // 00:01 IST Jan 2
    await t("exit_intent", "2032-01-02T10:00:00Z");
    const rows = (await funnelByTriggerDay(new Date("2031-12-30T00:00:00Z"), new Date("2032-01-05T00:00:00Z"))).filter((r) => ["exit_intent", "wishlist"].includes(r.trigger) && r.day.startsWith("2032-01"));
    expect(rows.map((r) => `${r.day}:${r.trigger}:${r.started}`)).toEqual(["2032-01-02:exit_intent:2", "2032-01-01:wishlist:1"]);
  });
  it("empty range returns []", async () => {
    expect(await funnelByTriggerDay(new Date("1990-01-01"), new Date("1990-01-02"))).toEqual([]);
  });
});

describe("no raw phone is ever persisted by the capture flow", () => {
  it("scans the whole capture row + events for the raw number", async () => {
    const ph = "+919876500123";
    const p = await person({ phone: ph });
    const id = await start();
    await markOtpSent(id, ph);
    await markVerified(id, p.id, true, ph);
    await completeUnlock(p.id, id);
    const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);
    const blob = JSON.stringify(await row(id)) + JSON.stringify(await prisma.domainEvent.findMany({ where: { aggregateId: id } }), big);
    expect(blob).not.toContain(ph);
    expect(blob).not.toContain("9876500123");
    const b = await prisma.businessMember.findMany({ where: { personId: p.id } });
    void b;
  });
});
