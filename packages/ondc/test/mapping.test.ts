import { generateEncryptionKeyPair, generateSigningKeyPair } from "../src/crypto";
import { describe, expect, it } from "vitest";
import { loadConfig, configStatus, isEnabled, REGISTRY_URLS } from "../src/config";
import { applyIntent, buildCatalog, buildProvider, categoryIdFor, decimalToPaise, ineligibleReason, listingToItem, paiseToDecimal, providerHash } from "../src/mapping";
import { quoteOrder } from "../src/quote";
import { cityAllowed, nack, ERROR_CODES, itemCount, callbackContext } from "../src/beckn";
import { listing } from "./fixtures";


const SELLER = "11111111-1111-4111-8111-111111111111";
const L1 = "22222222-2222-4222-8222-222222222222";

describe("money", () => {
  it("converts paise and decimals", () => {
    expect(paiseToDecimal(8450)).toBe("84.50");
    expect(paiseToDecimal(5)).toBe("0.05");
    expect(paiseToDecimal(100000)).toBe("1000.00");
    expect(decimalToPaise("84.5")).toBe(8450);
    expect(decimalToPaise("84")).toBe(8400);
    expect(decimalToPaise("84.505")).toBeNull();
    expect(decimalToPaise("-1")).toBeNull();
    expect(decimalToPaise(null)).toBeNull();
    expect(decimalToPaise(12.5)).toBe(1250);
  });
});

describe("listing -> Beckn item (snapshot)", () => {
  it("maps descriptor, price, MOQ as minimum, HSN and attribute tags", () => {
    const l = listing({ id: L1, sellerBusinessId: SELLER });
    expect(listingToItem(l, { categoryId: "Industrial" })).toMatchSnapshot();
  });
  it("omits optional pieces", () => {
    const l = listing({ id: L1, sellerBusinessId: SELLER, moq: null, hsn: null, attributes: {}, priceUnit: null, description: "d".repeat(3000), title: "t".repeat(300) });
    const it = listingToItem(l, { categoryId: "X" });
    expect(it.quantity.minimum).toBeUndefined();
    expect(it.descriptor.code).toBeUndefined();
    expect(it.quantity.unitized.measure.unit).toBe("unit");
    expect(it.descriptor.long_desc.length).toBe(2000);
    expect(it.descriptor.name.length).toBe(200);
    expect(it.tags.find((t) => t.code === "attributes")).toBeUndefined();
  });
});

describe("eligibility", () => {
  const base = listing({ sellerBusinessId: SELLER });
  it("gates on opt-in, live status, moderation, tier and price", () => {
    expect(ineligibleReason(base, true)).toBeNull();
    expect(ineligibleReason(base, false)).toBe("not_opted_in");
    expect(ineligibleReason({ ...base, status: "draft" }, true)).toBe("not_published");
    expect(ineligibleReason({ ...base, moderationStatus: "pending" }, true)).toBe("not_approved");
    expect(ineligibleReason({ ...base, seller: { ...base.seller!, verificationTier: 0 } }, true)).toBe("seller_unverified");
    expect(ineligibleReason({ ...base, seller: undefined }, true)).toBe("seller_unverified");
    expect(ineligibleReason({ ...base, pricePaise: null }, true)).toBe("no_price");
    expect(ineligibleReason({ ...base, pricePaise: 0 }, true)).toBe("no_price");
  });
  it("resolves categories: override > map > fallback", () => {
    expect(categoryIdFor(base, { "steel-pipes": "Industrial" })).toBe("Industrial");
    expect(categoryIdFor(base, { "steel-pipes": "Industrial" }, "Custom")).toBe("Custom");
    expect(categoryIdFor(base, {})).toBe("Others");
  });
});

describe("provider + catalog", () => {
  const a = listing({ id: L1, sellerBusinessId: SELLER });
  const b = listing({ id: "33333333-3333-4333-8333-333333333333", sellerBusinessId: SELLER, title: "Cotton yarn 30s", category: { id: "44444444-4444-4444-8444-444444444444", slug: "yarn", name: "Yarn" }, pricePaise: 25000, priceUnit: "kg", moq: 10 });
  const hidden = listing({ id: "55555555-5555-4555-8555-555555555555", sellerBusinessId: SELLER, moderationStatus: "review" });
  const provider = () => buildProvider({ sellerBusinessId: SELLER, listings: [a, b, hidden], optIns: new Map([[a.id, null], [b.id, "Textiles"], [hidden.id, null]]), categoryMap: { "steel-pipes": "Industrial" } })!;

  it("publishes only eligible opted-in listings (snapshot)", () => {
    const p = provider();
    expect(p.items.map((i) => i.id)).toEqual([a.id, b.id]);
    expect(p.items.map((i) => i.category_id)).toEqual(["Industrial", "Textiles"]);
    expect(buildCatalog("bpp.example.com", [p])).toMatchSnapshot();
  });
  it("returns null when nothing qualifies and hashes deterministically", () => {
    expect(buildProvider({ sellerBusinessId: SELLER, listings: [a], optIns: new Map(), categoryMap: {} })).toBeNull();
    expect(providerHash(null)).toBe(providerHash(null));
    expect(providerHash(provider())).toBe(providerHash(provider()));
    expect(providerHash(provider())).not.toBe(providerHash(null));
  });
  it("filters by intent text, category and provider", () => {
    const p = [provider()];
    expect(applyIntent(p, { text: "cotton" })[0]!.items).toHaveLength(1);
    expect(applyIntent(p, { text: "ERW pipe" })[0]!.items[0]!.id).toBe(a.id);
    expect(applyIntent(p, { text: "nothing" })).toEqual([]);
    expect(applyIntent(p, { categoryId: "Textiles" })[0]!.items[0]!.id).toBe(b.id);
    expect(applyIntent(p, { providerId: "other" })).toEqual([]);
    expect(applyIntent(p, {})[0]!.items).toHaveLength(2);
  });
  it("quotes from catalogue prices and enforces MOQ", () => {
    const p = provider();
    const ok = quoteOrder(p, [{ id: a.id, quantity: { count: 100 } }, { id: b.id, quantity: { selected: { count: 10 } } }]);
    expect(ok).toMatchObject({ quote: { totalPaise: 8450 * 100 + 25000 * 10 } });
    expect("quote" in ok && ok.quote.message.price).toEqual({ currency: "INR", value: "10950.00" });
    expect(quoteOrder(p, [{ id: a.id, quantity: { count: 49 } }])).toMatchObject({ error: { code: "40002" } });
    expect(quoteOrder(p, [{ id: "missing" }])).toMatchObject({ error: { code: "30004" } });
    expect(quoteOrder(null, [{ id: a.id }])).toMatchObject({ error: { code: "30001" } });
    expect(itemCount({ id: "x" })).toBe(1);
  });
});

describe("config + beckn helpers", () => {
  it("defaults to disabled and staging", () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ enabled: false, env: "staging", registryUrl: REGISTRY_URLS.staging, domains: ["ONDC:RET10"], cityCodes: ["*"], signatureTtlSeconds: 300, allowHttp: false });
    expect(isEnabled({})).toBe(false);
    expect(isEnabled({ ONDC_ENABLED: "true" })).toBe(true);
  });
  it("parses env, guards prod http, bad JSON and bad keys", () => {
    const c = loadConfig({ ONDC_ENV: "prod", ONDC_ALLOW_HTTP: "true", ONDC_REGISTRY_URL: "https://r.example/x/", ONDC_DOMAINS: "A, B", ONDC_CATEGORY_MAP: '{"a":"B","c":1}', ONDC_SIGNING_PRIVATE_KEY: "junk", ONDC_SIGNATURE_TTL_SECONDS: "99999" });
    expect(c).toMatchObject({ env: "prod", allowHttp: false, registryUrl: "https://r.example/x", domains: ["A", "B"], categoryMap: { a: "B" }, signingPublicKey: null, signatureTtlSeconds: 3600 });
    expect(loadConfig({ ONDC_ENV: "weird", ONDC_CATEGORY_MAP: "{bad", ONDC_ALLOW_HTTP: "true" })).toMatchObject({ env: "staging", categoryMap: {}, allowHttp: true });
    expect(loadConfig({ ONDC_CATEGORY_MAP: "5" }).categoryMap).toEqual({});
  });
  it("reports status without leaking secrets", () => {
    const empty = configStatus(loadConfig({}));
    expect(empty).toMatchObject({ ready: false, signingKey: "missing", encryptionKey: "missing" });
    expect(empty.missing).toContain("ONDC_SIGNING_PRIVATE_KEY");
    expect(configStatus(loadConfig({ ONDC_SIGNING_PRIVATE_KEY: "junk" })).signingKey).toBe("invalid");
    
    const sk = generateSigningKeyPair(); const ek = generateEncryptionKeyPair();
    const full = configStatus(loadConfig({ ONDC_SUBSCRIBER_ID: "s", ONDC_UNIQUE_KEY_ID: "u", ONDC_SUBSCRIBER_URL: "https://s", ONDC_SIGNING_PRIVATE_KEY: sk.privateKey, ONDC_ENCRYPTION_PRIVATE_KEY: ek.privateKey, ONDC_ENCRYPTION_PUBLIC_KEY: ek.publicKey }));
    expect(full).toMatchObject({ ready: true, signingKey: "configured", encryptionKey: "configured", missing: [] });
    expect(JSON.stringify(full)).not.toContain(sk.privateKey);
  });
  it("builds NACKs, city policy and callback contexts", () => {
    expect(nack(ERROR_CODES.badRequest, "x")).toEqual({ message: { ack: { status: "NACK" } }, error: { type: "JSON-SCHEMA-ERROR", code: "10000", message: "Bad or malformed request: x" } });
    expect(nack(ERROR_CODES.invalidSignature).error.message).toBe("Invalid signature");
    expect(cityAllowed({ cityCodes: ["*"] }, undefined)).toBe(true);
    expect(cityAllowed({ cityCodes: ["std:080"] }, "std:080")).toBe(true);
    expect(cityAllowed({ cityCodes: ["std:080"] }, "std:011")).toBe(false);
    expect(cityAllowed({ cityCodes: ["std:080"] }, undefined)).toBe(false);
    const ctx = callbackContext({ ...loadConfig({ ONDC_SUBSCRIBER_ID: "bpp.x", ONDC_SUBSCRIBER_URL: "https://bpp.x" }) }, { domain: "D", action: "search", bap_id: "b", bap_uri: "https://b", transaction_id: "t", message_id: "m", timestamp: "" }, "on_search", { now: new Date("2026-01-01T00:00:00Z") });
    expect(ctx).toMatchObject({ action: "on_search", bpp_id: "bpp.x", bpp_uri: "https://bpp.x", message_id: "m", timestamp: "2026-01-01T00:00:00.000Z", core_version: "1.2.0" });
  });
});
