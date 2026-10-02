import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import * as ondc from "../src";
import { buildAuthHeader, decryptChallenge, encryptChallenge, generateEncryptionKeyPair, generateSigningKeyPair, parseAuthHeader, verifyAuthSignature } from "../src/crypto";
import { processInbound } from "../src/processor";
import { deliverCallback } from "../src/outbound";
import { listing } from "./fixtures";

const tag = randomUUID().slice(0, 8);
const bap = generateSigningKeyPair();
const bpp = generateSigningKeyPair();
const enc = generateEncryptionKeyPair();
const regEnc = generateEncryptionKeyPair();
const BPP_ID = `bpp-${tag}.example.com`;
const BAP_ID = `bap-${tag}.example.com`;
const BAP_URI = "https://93.184.216.34/ondc";
const SELLER = randomUUID();
const OTHER_SELLER = randomUUID();
const queue = new MemoryJobQueue();
const sellers = [SELLER, OTHER_SELLER];

const ENV_KEYS = ["ONDC_ENABLED", "ONDC_SUBSCRIBER_ID", "ONDC_UNIQUE_KEY_ID", "ONDC_SUBSCRIBER_URL", "ONDC_SIGNING_PRIVATE_KEY", "ONDC_ENCRYPTION_PRIVATE_KEY", "ONDC_ENCRYPTION_PUBLIC_KEY", "ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY", "ONDC_DOMAINS", "ONDC_SITE_REQUEST_ID"];
const saved: Record<string, string | undefined> = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const pipe = listing({ id: randomUUID(), sellerBusinessId: SELLER, title: `Pipe ${tag}` });
const draft = listing({ id: randomUUID(), sellerBusinessId: SELLER, status: "draft", title: `Draft ${tag}` });
const live: Record<string, ReturnType<typeof listing>[]> = { [SELLER]: [pipe], [OTHER_SELLER]: [] };
let working: Record<string, ReturnType<typeof listing>[]> = { [SELLER]: [pipe, draft], [OTHER_SELLER]: [] };
let sent: { url: string; init: { headers: Record<string, string>; body?: string } }[] = [];
let fetchStatus = 200;
let fetchBody = JSON.stringify({ message: { ack: { status: "ACK" } } });

const setEnv = (on: boolean) => { process.env.ONDC_ENABLED = on ? "true" : "false"; };
const ctx = (action: string, over: Record<string, unknown> = {}) => ({
  domain: "ONDC:RET10", country: "IND", city: "std:080", action, core_version: "1.2.0", bap_id: BAP_ID, bap_uri: BAP_URI, bpp_id: BPP_ID, bpp_uri: "https://bpp",
  transaction_id: randomUUID(), message_id: randomUUID(), timestamp: new Date().toISOString(), ttl: "PT30S", ...over,
});
type Ctx = ReturnType<typeof ctx>;
async function post(action: string, context: Ctx, message: unknown, o: { key?: string; sign?: boolean; body?: string } = {}) {
  const body = o.body ?? JSON.stringify({ context, message });
  const authorization = o.sign === false ? null : buildAuthHeader({ body, subscriberId: BAP_ID, uniqueKeyId: "bap-k1", privateKey: o.key ?? bap.privateKey });
  return ondc.receiveInbound({ action, rawBody: body, authorization });
}
const inboundRow = (c: Ctx, action: string) => prisma.ondcMessage.findFirstOrThrow({ where: { direction: "inbound", action, transactionId: c.transaction_id, messageId: c.message_id } });
const outbound = (c: { transaction_id: string }, action: string) => prisma.ondcMessage.findMany({ where: { direction: "outbound", action, transactionId: c.transaction_id } });
async function run(c: Ctx, action: string) { await processInbound((await inboundRow(c, action)).id); }
async function sendAll() { for (const m of await prisma.ondcMessage.findMany({ where: { direction: "outbound", status: "pending", counterpartyId: BAP_ID } })) await deliverCallback(m.id); }

beforeAll(() => {
  setJobQueue(queue);
  process.env.ONDC_SUBSCRIBER_ID = BPP_ID; process.env.ONDC_UNIQUE_KEY_ID = "bpp-k1"; process.env.ONDC_SUBSCRIBER_URL = "https://bpp.example.com/ondc";
  process.env.ONDC_SIGNING_PRIVATE_KEY = bpp.privateKey; process.env.ONDC_ENCRYPTION_PRIVATE_KEY = enc.privateKey; process.env.ONDC_ENCRYPTION_PUBLIC_KEY = enc.publicKey;
  process.env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY = regEnc.publicKey; process.env.ONDC_DOMAINS = "ONDC:RET10"; process.env.ONDC_SITE_REQUEST_ID = "req-1";
  setEnv(true);
  ondc.setCatalogSource({ live: async (id) => live[id] ?? [], working: async (id) => working[id] ?? [] });
  ondc.setRegistry({ lookup: async ({ subscriberId, uniqueKeyId }) => subscriberId === BAP_ID && uniqueKeyId === "bap-k1"
    ? { subscriberId, uniqueKeyId, signingPublicKey: bap.publicKey, status: "SUBSCRIBED", validFrom: null, validUntil: null, type: "BAP", subscriberUrl: BAP_URI } : null });
});
const stubFetch = () => ondc.setFetch(async (url, init) => { sent.push({ url, init }); return { ok: fetchStatus < 400, status: fetchStatus, text: async () => fetchBody }; });
beforeEach(() => { stubFetch(); sent = []; fetchStatus = 200; fetchBody = JSON.stringify({ message: { ack: { status: "ACK" } } }); setEnv(true); ondc.setOrderSink(null); });
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  ondc.setCatalogSource(undefined); ondc.setRegistry(undefined); ondc.setFetch(undefined); ondc.setOrderSink(null); setJobQueue(undefined);
  await prisma.ondcListingOptIn.deleteMany({ where: { sellerBusinessId: { in: sellers } } });
  await prisma.ondcOrder.deleteMany({ where: { sellerBusinessId: { in: sellers } } });
  await prisma.ondcMessage.deleteMany({ where: { counterpartyId: BAP_ID } });
  await prisma.ondcSeller.deleteMany({ where: { businessId: { in: sellers } } });
  await prisma.domainEvent.deleteMany({ where: { type: { in: ["OndcCatalogPublished", "OndcOrderReceived"] }, payload: { path: ["sellerBusinessId"], string_contains: SELLER } } });
});

let confirmCtx: Ctx; let orderId: string;
const actor = { personId: randomUUID(), businessId: SELLER };
const events = (type: string) => prisma.domainEvent.findMany({ where: { type, aggregateType: type === "OndcOrderReceived" ? "ondc_order" : "ondc_seller" } , orderBy: { occurredAt: "asc" } }).then((r) => r.filter((e) => (e.payload as { sellerBusinessId: string }).sellerBusinessId === SELLER));

describe("seller opt-in and publish", () => {
  it("requires the current terms, then connects", async () => {
    await expect(ondc.connectSeller(actor, { acceptTermsVersion: "old" })).rejects.toMatchObject({ code: "validation" });
    expect(await ondc.getSellerState(actor.businessId)).toMatchObject({ connected: false });
    expect(await ondc.getSellerState("not-a-uuid")).toMatchObject({ connected: false });
    expect(await ondc.connectSeller(actor, { acceptTermsVersion: ondc.TERMS_VERSION })).toMatchObject({ connected: true, enabled: true, termsVersion: ondc.TERMS_VERSION });
  });

  it("opts listings in/out; only own listings", async () => {
    await expect(ondc.setListingOptIn(actor, "bad", true)).rejects.toMatchObject({ code: "not_found" });
    await expect(ondc.setListingOptIn(actor, randomUUID(), true)).rejects.toMatchObject({ code: "not_found" });
    await ondc.setListingOptIn(actor, pipe.id, true, "  Industrial  ");
    await ondc.setListingOptIn(actor, pipe.id, true, "Industrial");
    await ondc.setListingOptIn(actor, draft.id, true);
    const rows = await ondc.listSellerListingOptIns(SELLER);
    expect(rows.find((r) => r.listingId === pipe.id)).toMatchObject({ optedIn: true, reason: null });
    expect(rows.find((r) => r.listingId === draft.id)).toMatchObject({ optedIn: true, reason: "not_published" });
    working = { ...working, [SELLER]: [pipe, draft, { ...pipe, id: randomUUID(), status: "archived" }] };
    expect((await ondc.listSellerListingOptIns(SELLER))).toHaveLength(2);
    await ondc.setListingOptIn(actor, draft.id, false);
    expect((await ondc.listSellerListingOptIns(SELLER)).find((r) => r.listingId === draft.id)?.optedIn).toBe(false);
  });

  it("publishes once per change and emits OndcCatalogPublished", async () => {
    const r1 = await ondc.publishCatalog(SELLER);
    expect(r1).toEqual({ published: true, items: 1 });
    expect(await ondc.publishCatalog(SELLER)).toMatchObject({ published: false, skipped: "unchanged" });
    expect((await events("OndcCatalogPublished")).map((e) => e.payload)).toEqual([{ sellerBusinessId: SELLER, providerId: SELLER, items: 1 }]);
    expect(await ondc.publishCatalog(randomUUID())).toMatchObject({ skipped: "not_connected" });
    setEnv(false);
    expect(await ondc.publishCatalog(SELLER)).toMatchObject({ skipped: "disabled" });
    expect(await ondc.publishAllCatalogs()).toBe(0);
    expect(await ondc.allProviders()).toEqual([]);
    setEnv(true);
    expect(await ondc.providerFor("bad-id")).toBeNull();
    // publishAllCatalogs sweeps EVERY connected seller in the shared DB, including other test files' sellers (their catalogue
    // lives in another worker's source); scope the sweep to this file's sellers so a foreign republish can't be counted.
    vi.spyOn(prisma.ondcSeller, "findMany").mockResolvedValueOnce(sellers.map((businessId) => ({ businessId })) as never);
    expect(await ondc.publishAllCatalogs()).toBe(0);
  });

  it("withdraws the catalogue on disconnect", async () => {
    await ondc.disconnectSeller(actor);
    expect(await ondc.providerFor(SELLER)).toBeNull();
    expect(await ondc.publishCatalog(SELLER)).toEqual({ published: true, items: 0 });
    await ondc.connectSeller(actor, { acceptTermsVersion: ondc.TERMS_VERSION });
    expect(await ondc.publishCatalog(SELLER)).toEqual({ published: true, items: 1 });
    expect(await ondc.publishAllCatalogs()).toBe(0);
  });
});

describe("inbound protocol", () => {
  it("is off (404) unless ONDC_ENABLED", async () => {
    setEnv(false);
    const c = ctx("search");
    expect((await post("search", c, { intent: {} })).status).toBe(404);
    setEnv(true);
    expect((await post("bogus", c, {})).status).toBe(404);
  });

  it("NACKs bad JSON, bad envelope, missing/invalid signatures, unknown signer and registry outages", async () => {
    const c = ctx("search");
    expect(await post("search", c, {}, { body: "{nope" })).toMatchObject({ status: 400 });
    expect(await post("search", c, {}, { body: JSON.stringify({ context: { action: "search" } }) })).toMatchObject({ status: 400 });
    expect(await post("search", ctx("select"), {})).toMatchObject({ status: 400 }); // action mismatch
    expect(await post("search", c, {}, { body: "x".repeat(ondc.MAX_BODY_BYTES + 1) })).toMatchObject({ status: 413 });
    expect(await post("search", c, {}, { sign: false })).toMatchObject({ status: 401, body: { message: { ack: { status: "NACK" } }, error: { code: "10001" } } });
    expect(await post("search", c, {}, { key: generateSigningKeyPair().privateKey })).toMatchObject({ status: 401 });
    // signer identity must equal context.bap_id
    expect(await post("search", ctx("search", { bap_id: "someone.else" }), {})).toMatchObject({ status: 401 });
    // tampered body after signing
    const body = JSON.stringify({ context: c, message: { intent: {} } });
    const auth = buildAuthHeader({ body, subscriberId: BAP_ID, uniqueKeyId: "bap-k1", privateKey: bap.privateKey });
    expect(await ondc.receiveInbound({ action: "search", rawBody: body + " ", authorization: auth })).toMatchObject({ status: 401 });
    ondc.setRegistry({ lookup: async () => { throw new Error("down"); } });
    expect(await post("search", c, {})).toMatchObject({ status: 503 });
    ondc.setRegistry({ lookup: async ({ subscriberId, uniqueKeyId }) => subscriberId === BAP_ID && uniqueKeyId === "bap-k1" ? { subscriberId, uniqueKeyId, signingPublicKey: bap.publicKey, status: "SUBSCRIBED", validFrom: null, validUntil: null, type: "BAP", subscriberUrl: null } : null });
  });

  it("enforces domain, city, bpp_id and message shape", async () => {
    expect(await post("search", ctx("search", { domain: "ONDC:OTHER" }), { intent: {} })).toMatchObject({ status: 400, body: { error: { code: "10002" } } });
    expect(await post("select", ctx("select", { bpp_id: "not.us" }), { order: {} })).toMatchObject({ status: 400, body: { error: { code: "10003" } } });
    expect(await post("select", ctx("select"), { order: { items: [] } })).toMatchObject({ status: 400, body: { error: { code: "10000" } } });
    expect(await post("status", ctx("status"), {})).toMatchObject({ status: 400 });
    process.env.ONDC_DOMAINS = "ONDC:RET10";
  });

  it("ACKs and stores a search once; duplicates and retries are idempotent", async () => {
    const c = ctx("search");
    const msg = { intent: { item: { descriptor: { name: "erw" } } } };
    expect((await post("search", c, msg)).body).toEqual(ondc.ACK);
    expect((await post("search", c, msg)).body).toEqual(ondc.ACK);
    expect(await prisma.ondcMessage.count({ where: { direction: "inbound", transactionId: c.transaction_id } })).toBe(1);
    // a failed one is re-queued on redelivery
    const row = await inboundRow(c, "search");
    await prisma.ondcMessage.update({ where: { id: row.id }, data: { status: "failed" } });
    expect((await post("search", c, msg)).status).toBe(200);
    expect((await inboundRow(c, "search")).status).toBe("received");
    // enqueue failure -> 503 + failed row
    vi.spyOn(queue, "enqueue").mockRejectedValueOnce(new Error("redis"));
    const c2 = ctx("search");
    expect((await post("search", c2, msg)).status).toBe(503);
    expect((await inboundRow(c2, "search")).status).toBe("failed");
  });

  it("search -> on_search callback signed with our key; silent when nothing matches", async () => {
    const c = ctx("search");
    await post("search", c, { intent: { item: { descriptor: { name: "erw pipe" } } } });
    await run(c, "search");
    await run(c, "search"); // redelivery: skipped
    const [cb] = await outbound(c, "on_search");
    expect(cb!.status).toBe("pending");
    const body = cb!.body as { context: Record<string, string>; message: { catalog: { "bpp/providers": { id: string; items: { id: string }[] }[] } } };
    expect(body.context).toMatchObject({ action: "on_search", bpp_id: BPP_ID, bap_id: BAP_ID, transaction_id: c.transaction_id, message_id: c.message_id });
    const provider = body.message.catalog["bpp/providers"].find((p) => p.id === SELLER)!;
    expect(provider.items.map((i) => i.id)).toEqual([pipe.id]);

    expect(await deliverCallback(cb!.id)).toBe("sent");
    expect(await deliverCallback(cb!.id)).toBe("skipped"); // already sent
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${BAP_URI}/on_search`);
    const parsed = parseAuthHeader(sent[0]!.init.headers.authorization)!;
    expect(parsed).toMatchObject({ subscriberId: BPP_ID, uniqueKeyId: "bpp-k1" });
    expect(verifyAuthSignature(parsed, sent[0]!.init.body!, bpp.publicKey)).toEqual({ ok: true });

    const c2 = ctx("search");
    await post("search", c2, { intent: { item: { descriptor: { name: "zzzz-nothing" } } } });
    await run(c2, "search");
    expect(await outbound(c2, "on_search")).toHaveLength(0);
  });

  it("select/init quote from catalogue prices, ignoring anything the buyer claims", async () => {
    const c = ctx("select");
    await post("select", c, { order: { provider: { id: SELLER }, items: [{ id: pipe.id, quantity: { count: 100 }, price: { value: "1.00" } }] } });
    await run(c, "select");
    const sel = (await outbound(c, "on_select"))[0]!.body as { message: { order: { quote: { price: { value: string } } } } };
    expect(sel.message.order.quote.price.value).toBe("8450.00");

    const ci = ctx("init");
    await post("init", ci, { order: { provider: { id: SELLER }, items: [{ id: pipe.id, quantity: { count: 100 } }], billing: { name: "Buyer" }, fulfillments: [{ id: "F1" }] } });
    await run(ci, "init");
    const init = (await outbound(ci, "on_init"))[0]!.body as { message: { order: { payment: { status: string } } } };
    expect(init.message.order.payment.status).toBe("NOT-PAID");

    const bad = ctx("select");
    await post("select", bad, { order: { provider: { id: SELLER }, items: [{ id: pipe.id, quantity: { count: 1 } }] } });
    await run(bad, "select");
    expect((await outbound(bad, "on_select"))[0]!.body).toMatchObject({ error: { code: "40002" } });
    const none = ctx("select");
    await post("select", none, { order: { provider: { id: "nope" }, items: [{ id: pipe.id }] } });
    await run(none, "select");
    expect((await outbound(none, "on_select"))[0]!.body).toMatchObject({ error: { code: "30001" } });
  });

  it("confirm creates the order once, emits OndcOrderReceived once, and answers on_confirm", async () => {
    confirmCtx = ctx("confirm");
    const msg = { order: { provider: { id: SELLER }, items: [{ id: pipe.id, quantity: { count: 100 } }], billing: { name: "Buyer Co", email: "b@x.in" }, payment: { type: "POST-FULFILLMENT" } } };
    await post("confirm", confirmCtx, msg);
    await run(confirmCtx, "confirm");
    await run(confirmCtx, "confirm"); // skipped: processed
    // simulate an at-least-once redelivery of the job after a crash before "processed"
    await prisma.ondcMessage.update({ where: { id: (await inboundRow(confirmCtx, "confirm")).id }, data: { status: "received" } });
    await run(confirmCtx, "confirm");
    const orders = await prisma.ondcOrder.findMany({ where: { transactionId: confirmCtx.transaction_id } });
    expect(orders).toHaveLength(1);
    orderId = orders[0]!.id;
    expect(orders[0]).toMatchObject({ status: "created", totalPaise: 845000n, bapId: BAP_ID, sellerBusinessId: SELLER, internalOrderId: null });
    expect((orders[0]!.payload as { message: unknown }).message).toEqual(msg);
    const ev = (await events("OndcOrderReceived")).filter((e) => (e.payload as { ondcOrderId: string }).ondcOrderId === orderId);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toEqual({ ondcOrderId: orderId, orderId: null, sellerBusinessId: SELLER, bapId: BAP_ID, transactionId: confirmCtx.transaction_id });
    const cb = (await outbound(confirmCtx, "on_confirm"))[0]!.body as { message: { order: { id: string; state: string } } };
    expect(cb.message.order).toMatchObject({ id: orderId, state: "Created" });
  });

  it("confirm hands the order to the sink and records the internal id", async () => {
    const seen: unknown[] = [];
    ondc.setOrderSink({ recordExternalOrder: async (i) => { seen.push(i); return { orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }; } });
    const c = ctx("confirm");
    await post("confirm", c, { order: { provider: { id: SELLER }, items: [{ id: pipe.id, quantity: { count: 60 } }], billing: { name: "Sink Buyer" } } });
    await run(c, "confirm");
    const o = await prisma.ondcOrder.findFirstOrThrow({ where: { transactionId: c.transaction_id } });
    expect(o.internalOrderId).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(seen[0]).toMatchObject({ externalRef: `ondc:${o.id}`, source: "ondc", buyerLabel: "Sink Buyer", totalPaise: 507000, items: [{ listingId: pipe.id, quantity: 60, unitPricePaise: 8450, unit: "kg" }] });
    const ev = (await events("OndcOrderReceived")).find((e) => (e.payload as { ondcOrderId: string }).ondcOrderId === o.id);
    expect(ev!.payload).toMatchObject({ orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  });

  it("a failing sink never loses the order; it is re-offered on redelivery", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    ondc.setOrderSink({ recordExternalOrder: async () => { if (n++ === 0) throw new Error("boom"); return null; } });
    const c = ctx("confirm");
    await post("confirm", c, { order: { provider: { id: SELLER }, items: [{ id: pipe.id, quantity: { count: 55 } }] } });
    await run(c, "confirm");
    const o = await prisma.ondcOrder.findFirstOrThrow({ where: { transactionId: c.transaction_id } });
    expect(o.receivedEmittedAt).toBeNull();
    await prisma.ondcMessage.update({ where: { id: (await inboundRow(c, "confirm")).id }, data: { status: "received" } });
    await run(c, "confirm");
    expect((await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.id } })).receivedEmittedAt).not.toBeNull();
    expect(n).toBe(2);
  });

  it("confirm for an unavailable item answers with an error and stores no order", async () => {
    const c = ctx("confirm");
    await post("confirm", c, { order: { provider: { id: SELLER }, items: [{ id: randomUUID(), quantity: { count: 100 } }] } });
    await run(c, "confirm");
    expect(await prisma.ondcOrder.count({ where: { transactionId: c.transaction_id } })).toBe(0);
    expect((await outbound(c, "on_confirm"))[0]!.body).toMatchObject({ error: { code: "30004" } });
  });

  it("status reports the order; unknown or foreign orders are errors", async () => {
    const c = ctx("status", { transaction_id: confirmCtx.transaction_id });
    await post("status", c, { order_id: orderId });
    await run(c, "status");
    expect((await outbound(c, "on_status"))[0]!.body).toMatchObject({ message: { order: { id: orderId, state: "Created" } } });
    const c2 = ctx("status");
    await post("status", c2, { order_id: randomUUID() });
    await run(c2, "status");
    expect((await outbound(c2, "on_status"))[0]!.body).toMatchObject({ error: { code: "30004" } });
    const c3 = ctx("status");
    await post("status", c3, { order_id: "not-a-uuid" });
    await run(c3, "status");
    expect((await outbound(c3, "on_status"))[0]!.body).toMatchObject({ error: { code: "30004" } });
  });

  it("seller inbox: list, accept (on_status), idempotent accept, cancel by buyer, reject", async () => {
    const list = await ondc.listSellerOrders(SELLER, { status: "created" });
    expect(list.find((o) => o.id === orderId)).toMatchObject({ status: "created", totalPaise: 845000, lines: [{ itemId: pipe.id, count: 100, unitPaise: 8450 }] });
    await expect(ondc.acceptOrder(OTHER_SELLER, orderId)).rejects.toMatchObject({ code: "not_found" });
    await expect(ondc.acceptOrder(SELLER, "bad")).rejects.toMatchObject({ code: "not_found" });
    expect(await ondc.acceptOrder(SELLER, orderId)).toMatchObject({ status: "accepted" });
    expect(await ondc.acceptOrder(SELLER, orderId)).toMatchObject({ status: "accepted" });
    const accepted = (await prisma.ondcMessage.findMany({ where: { direction: "outbound", action: "on_status", transactionId: confirmCtx.transaction_id } }));
    expect(accepted.some((m) => (m.body as { message: { order: { state: string } } }).message.order.state === "Accepted")).toBe(true);
    await expect(ondc.rejectOrder(SELLER, orderId)).rejects.toMatchObject({ code: "conflict" });

    // buyer cancels an accepted order
    const cc = ctx("cancel", { transaction_id: confirmCtx.transaction_id });
    await post("cancel", cc, { order_id: orderId, cancellation_reason_id: "002" });
    await run(cc, "cancel");
    expect((await outbound(cc, "on_cancel"))[0]!.body).toMatchObject({ message: { order: { state: "Cancelled", cancellation: { reason: { id: "002" } } } } });
    // cancelling again is idempotent; a completed order cannot be cancelled
    const again = ctx("cancel", { transaction_id: confirmCtx.transaction_id });
    await post("cancel", again, { order_id: orderId });
    await run(again, "cancel");
    expect((await outbound(again, "on_cancel"))[0]!.body).toMatchObject({ message: { order: { state: "Cancelled" } } });
    await prisma.ondcOrder.update({ where: { id: orderId }, data: { status: "completed" } });
    const cc2 = ctx("cancel");
    await post("cancel", cc2, { order_id: orderId });
    await run(cc2, "cancel");
    expect((await outbound(cc2, "on_cancel"))[0]!.body).toMatchObject({ error: { code: "45003" } });
    const cc3 = ctx("cancel");
    await post("cancel", cc3, { order_id: randomUUID() });
    await run(cc3, "cancel");
    expect((await outbound(cc3, "on_cancel"))[0]!.body).toMatchObject({ error: { code: "30004" } });

    // seller rejects a fresh order
    const c = ctx("confirm");
    await post("confirm", c, { order: { provider: { id: SELLER }, items: [{ id: pipe.id, quantity: { count: 51 } }] } });
    await run(c, "confirm");
    const o = await prisma.ondcOrder.findFirstOrThrow({ where: { transactionId: c.transaction_id } });
    expect(await ondc.rejectOrder(SELLER, o.id, "011")).toMatchObject({ status: "cancelled", cancelReason: "011" });
    expect(await ondc.rejectOrder(SELLER, o.id)).toMatchObject({ status: "cancelled" });
    expect((await outbound(c, "on_cancel"))).toHaveLength(1);
  });
});

describe("outbound delivery", () => {
  async function pending() {
    const c = ctx("search");
    await post("search", c, { intent: { item: { descriptor: { name: "erw" } } } });
    await run(c, "search");
    return (await outbound(c, "on_search"))[0]!;
  }
  it("retries transient failures (throws), then replay works after the failure is cleared", async () => {
    const m = await pending();
    fetchStatus = 503;
    await expect(deliverCallback(m.id)).rejects.toThrow(/503/);
    expect(await prisma.ondcMessage.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ status: "failed", httpStatus: 503, attempts: 1 });
    ondc.setFetch(async () => { throw new Error("ECONNRESET"); });
    await expect(deliverCallback(m.id)).rejects.toThrow("ECONNRESET");
    stubFetch(); fetchStatus = 200;
    expect(await ondc.replayCallback(m.id)).toBe(true);
    expect(await ondc.replayCallback(m.id)).toBe(false); // no longer failed
    expect(await deliverCallback(m.id)).toBe("sent");
    expect((await prisma.ondcMessage.findUniqueOrThrow({ where: { id: m.id } })).status).toBe("sent");
  });
  it("marks a NACK from the buyer app as failed without retrying", async () => {
    const m = await pending();
    fetchBody = JSON.stringify({ message: { ack: { status: "NACK" } } });
    expect(await deliverCallback(m.id)).toBe("rejected");
    expect((await ondc.listFailedCallbacks()).some((r) => r.id === m.id)).toBe(true);
    const m2 = await pending();
    fetchStatus = 400; fetchBody = "not json";
    expect(await deliverCallback(m2.id)).toBe("rejected");
    const m3 = await pending();
    fetchBody = "plain ok";
    fetchStatus = 200;
    expect(await deliverCallback(m3.id)).toBe("sent");
  });
  it("refuses non-public callback URLs (SSRF) permanently", async () => {
    const c = ctx("search", { bap_uri: "https://10.0.0.5/ondc" });
    await post("search", c, { intent: { item: { descriptor: { name: "erw" } } } });
    await run(c, "search");
    const m = (await outbound(c, "on_search"))[0]!;
    expect(await deliverCallback(m.id)).toBe("rejected");
    expect(sent).toHaveLength(0);
    expect((await prisma.ondcMessage.findUniqueOrThrow({ where: { id: m.id } })).error).toMatch(/not a public/);
  });
  it("is inert with the flag off and errors when unconfigured", async () => {
    const m = await pending();
    setEnv(false);
    expect(await deliverCallback(m.id)).toBe("skipped");
    expect(await processInbound(m.id)).toBe("skipped");
    setEnv(true);
    expect(await deliverCallback(randomUUID())).toBe("skipped");
    const key = process.env.ONDC_SIGNING_PRIVATE_KEY;
    delete process.env.ONDC_SIGNING_PRIVATE_KEY;
    await expect(deliverCallback(m.id)).rejects.toThrow(/not configured/);
    process.env.ONDC_SIGNING_PRIVATE_KEY = key;
  });
  it("processing failures mark the message failed and rethrow", async () => {
    const c = ctx("select");
    await post("select", c, { order: { provider: { id: SELLER }, items: [{ id: pipe.id }] } });
    const row = await inboundRow(c, "select");
    await prisma.ondcMessage.update({ where: { id: row.id }, data: { body: { context: c, message: { broken: true } } } });
    await expect(processInbound(row.id)).rejects.toThrow();
    expect((await prisma.ondcMessage.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("failed");
  });
});

describe("registry onboarding endpoints", () => {
  it("answers on_subscribe by decrypting the challenge", () => {
    const challenge = encryptChallenge("answer-42", regEnc.privateKey, enc.publicKey);
    expect(ondc.handleOnSubscribe({ subscriber_id: BPP_ID, challenge })).toEqual({ status: 200, body: { answer: "answer-42" } });
    expect(ondc.handleOnSubscribe({ subscriber_id: "other", challenge }).status).toBe(400);
    expect(ondc.handleOnSubscribe({ nope: 1 }).status).toBe(400);
    expect(ondc.handleOnSubscribe({ subscriber_id: BPP_ID, challenge: "AAAA" }).status).toBe(400);
    expect(decryptChallenge(challenge, enc.privateKey, regEnc.publicKey)).toBe("answer-42");
    const k = process.env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY;
    delete process.env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY;
    expect(ondc.handleOnSubscribe({ subscriber_id: BPP_ID, challenge }).status).toBe(503);
    process.env.ONDC_REGISTRY_ENCRYPTION_PUBLIC_KEY = k;
    setEnv(false);
    expect(ondc.handleOnSubscribe({ subscriber_id: BPP_ID, challenge }).status).toBe(404);
    expect(ondc.siteVerification()).toBeNull();
    setEnv(true);
  });
  it("serves the signed site verification page only when configured", () => {
    expect(ondc.siteVerification()).toContain("ondc-site-verification");
    expect(ondc.siteVerification(ondc.loadConfig(), "")).toBeNull();
  });
});

describe("admin", () => {
  it("shows a redacted log, overview without secrets, and purges old messages", async () => {
    const rows = await ondc.listMessages({ direction: "inbound", limit: 500 });
    const confirm = rows.find((r) => r.action === "confirm" && JSON.stringify(r.body).includes("Buyer Co"));
    expect(confirm).toBeUndefined(); // buyer name redacted
    const conf = rows.find((r) => r.action === "confirm" && r.transactionId === confirmCtx.transaction_id)!;
    expect(JSON.stringify(conf.body)).toContain("[redacted]");
    expect(JSON.stringify(conf.body)).not.toContain("b@x.in");
    expect(JSON.stringify((await ondc.listMessages({ limit: 500 })).find((r) => r.action === "on_search")!.body)).toContain("Sharma Steels");
    const ov = await ondc.adminOverview();
    expect(ov.config.ready).toBe(true);
    expect(JSON.stringify(ov)).not.toContain(bpp.privateKey);
    expect(ov.connectedSellers).toBeGreaterThanOrEqual(1);
    const old = await prisma.ondcMessage.create({ data: { direction: "inbound", action: "search", transactionId: randomUUID(), messageId: randomUUID(), counterpartyId: BAP_ID, status: "processed", body: {}, createdAt: new Date(Date.now() - 200 * 86_400_000) } });
    expect(await ondc.purgeOldMessages(90)).toBeGreaterThanOrEqual(1);
    expect(await prisma.ondcMessage.findUnique({ where: { id: old.id } })).toBeNull();
    expect(ondc.redactBody({ a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: 1 } } } } } } } } } } } } })).toBeTruthy();
    expect(ondc.redactBody({ descriptor: { name: "Keep" }, billing: { name: "Hide" }, name: "Hide2", n: [1, { phone: "9" }] })).toEqual({ descriptor: { name: "Keep" }, billing: "[redacted]", name: "[redacted]", n: [1, { phone: "[redacted]" }] });
  });
  it("worker declares queues and jobs", async () => {
    expect(ondc.worker.name).toBe("ondc");
    expect(ondc.worker.queues!.map((q) => q.topic).sort()).toEqual(["ondc.callback", "ondc.inbound"]);
    setEnv(false);
    for (const j of ondc.worker.jobs) await j.run();
    setEnv(true);
    for (const j of ondc.worker.jobs) await j.run();
    const q = ondc.worker.queues!;
    await q[0]!.handler({ id: "1", topic: "ondc.inbound", payload: { messageId: randomUUID() }, attempt: 1, maxAttempts: 5, enqueuedAt: "" } as never);
    await q[1]!.handler({ id: "1", topic: "ondc.callback", payload: { messageId: randomUUID() }, attempt: 1, maxAttempts: 5, enqueuedAt: "" } as never);
  });
});
