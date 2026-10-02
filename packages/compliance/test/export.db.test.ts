// DPDP export registry (security audit M10): one streamed, bounded JSON document aggregating every module's personal data.
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { setConsent } from "@cnote/identity";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXPORT_SOURCES, personalExportStream, streamPersonalExport, RETENTION_POLICIES, type ExportSource } from "../src";

const tag = `exp-${randomUUID()}`;
let personId: string;
let businessId: string;
const consentId = randomUUID().replace(/-/g, "");

async function collect(gen: AsyncIterable<string>): Promise<{ text: string; json: Record<string, any> }> {
  let text = "";
  for await (const c of gen) text += c;
  return { text, json: JSON.parse(text) };
}

beforeAll(async () => {
  personId = (await prisma.person.create({ data: { email: `${tag}@example.com`, name: "Export Test" } })).id;
  businessId = (await prisma.business.create({ data: { name: tag } })).id;
  await prisma.businessMember.create({ data: { personId, businessId, role: "owner" } });
  await setConsent(personId, "marketing", true, "web");
  const wl = await prisma.wishlist.create({ data: { personId, name: tag, isDefault: false } });
  await prisma.wishlistItem.create({ data: { wishlistId: wl.id, listingId: randomUUID(), note: "five ply", savedPricePaise: 12_345_678_901n } });
  await prisma.notification.create({ data: { personId, kind: "test.kind", title: "Hello", body: "World", app: "web" } });
  await prisma.leadCapture.create({ data: { visitorId: tag, personId, trigger: "request_quote", unlock: "enquiry" } });
  await prisma.cookieConsentReceipt.create({ data: { consentId, policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom", locale: "en", personId } });
});
afterAll(async () => {
  await prisma.wishlist.deleteMany({ where: { personId } });
  await prisma.notification.deleteMany({ where: { personId } });
  await prisma.leadCapture.deleteMany({ where: { personId } });
  await prisma.cookieConsentReceipt.deleteMany({ where: { consentId } });
  await prisma.consent.deleteMany({ where: { personId } });
  await prisma.businessMember.deleteMany({ where: { personId } });
  await prisma.person.delete({ where: { id: personId } });
  await prisma.business.delete({ where: { id: businessId } });
});

describe("export registry", () => {
  it("covers every module that holds personal data, and each retention-registered module that stores per-person rows", () => {
    const modules = EXPORT_SOURCES.map((s) => s.module);
    for (const m of ["identity", "alerts", "enquiry", "reviews", "wishlist", "notifications", "catalogue", "leadgen", "disputes", "compliance"]) expect(modules).toContain(m);
    expect(new Set(modules).size).toBe(modules.length);
    // modules with a retention policy over per-person data must be exportable too (or be explicitly system-only)
    const systemOnly = new Set(["whatsapp", "credit", "ondc", "quality"]);
    for (const m of new Set(RETENTION_POLICIES.map((p) => p.module))) if (!systemOnly.has(m)) expect(modules, `retention module ${m} has no export source`).toContain(m);
  });
});

describe("personalExport (DB)", () => {
  it("aggregates every module into one valid JSON document, keeping the original top-level shape for identity + alerts", async () => {
    const { json } = await collect(streamPersonalExport(personId));
    expect(json.exportedAt).toEqual(expect.any(String));
    // original shape (identity + alerts flattened)
    expect(json.person.email).toBe(`${tag}@example.com`);
    expect(json.person.passwordHash).toBeUndefined();
    expect(json.businesses.map((b: any) => b.id)).toContain(businessId);
    expect(json.consents.some((c: any) => c.purpose === "marketing" && c.granted)).toBe(true);
    expect(json.followedSuppliers).toEqual([]);
    // per-module sections
    expect(json.wishlist.wishlists.items[0]).toMatchObject({ name: tag });
    expect(json.wishlist.wishlists.items[0].items[0]).toMatchObject({ note: "five ply", savedPricePaise: "12345678901" }); // BigInt paise survive as exact strings
    expect(json.notifications.notifications.items[0]).toMatchObject({ kind: "test.kind", title: "Hello" });
    expect(json.leadgen.leadCaptures.items[0]).toMatchObject({ trigger: "request_quote" });
    expect(json.compliance.cookieConsentReceipts.items[0]).toMatchObject({ analytics: true, action: "custom" });
    for (const m of ["enquiry", "reviews", "catalogue", "disputes"]) expect(json[m], m).toBeTypeOf("object");
    expect(json.enquiry.enquiries).toEqual({ items: [], truncated: false });
    expect(json._errors).toBeUndefined();
  });

  it("is a web ReadableStream that yields the same document", async () => {
    const res = new Response(personalExportStream(personId));
    const json = await res.json();
    expect(json.person.id).toBe(personId);
  });

  it("is bounded: sections past the byte budget are omitted and listed, the document stays valid JSON", async () => {
    const { json } = await collect(streamPersonalExport(personId, { maxBytes: 400 }));
    expect(json.exportedAt).toBeDefined();
    expect(json._omitted?.length ?? 0).toBeGreaterThan(0);
  });

  it("a failing module is reported in _errors and does not fail the export", async () => {
    const boom: ExportSource = { module: "boom", description: "x", export: async () => { throw new Error("boom"); } };
    const { json } = await collect(streamPersonalExport(personId, { sources: [...EXPORT_SOURCES.slice(0, 2), boom] }));
    expect(json._errors).toEqual(["boom"]);
    expect(json.person.id).toBe(personId);
  });

  it("an unknown or erased person discloses nothing beyond the timestamp", async () => {
    const { json } = await collect(streamPersonalExport(randomUUID()));
    expect(Object.keys(json)).toEqual(["exportedAt"]);
  });
});
