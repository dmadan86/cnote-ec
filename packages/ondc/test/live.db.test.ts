// ADR-021 live-participation: gateway auth, kill switch, fulfilment push, IGM, evaluation, readiness.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";

const disputes = vi.hoisted(() => ({
  enabled: true,
  openDispute: vi.fn(async (_a: unknown, _i: unknown) => ({ id: crypto.randomUUID() })),
  getDisputeForOrder: vi.fn(async (_a: unknown, _o: string): Promise<{ id: string } | null> => null),
  withdrawDispute: vi.fn(async (_a: unknown, _id: string) => {}),
}));
vi.mock("@cnote/disputes", () => ({ ...disputes, disputesEnabled: () => disputes.enabled }));

import * as ondc from "../src";
import { DomainError } from "@cnote/core";
import { buildAuthHeader, generateEncryptionKeyPair, generateSigningKeyPair } from "../src/crypto";
import { processInbound } from "../src/processor";
import { deliverCallback } from "../src/outbound";
import { resetKillSwitchCache } from "../src/killswitch";

const tag = randomUUID().slice(0, 8);
const bap = generateSigningKeyPair();
const gw = generateSigningKeyPair();
const bpp = generateSigningKeyPair();
const enc = generateEncryptionKeyPair();
const BPP_ID = `bpp-${tag}.example.com`;
const BAP_ID = `bap-${tag}.example.com`;
const SELLER = randomUUID();
const queue = new MemoryJobQueue();
const KEYS = ["ONDC_ENABLED", "ONDC_SUBSCRIBER_ID", "ONDC_UNIQUE_KEY_ID", "ONDC_SUBSCRIBER_URL", "ONDC_SIGNING_PRIVATE_KEY", "ONDC_ENCRYPTION_PRIVATE_KEY", "ONDC_ENCRYPTION_PUBLIC_KEY", "ONDC_REQUIRE_GATEWAY_AUTH", "ONDC_GRO_EMAIL", "ONDC_ENV"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let sent: { url: string; body: string }[] = [];

const ctx = (action: string, over: Record<string, unknown> = {}) => ({
  domain: "ONDC:RET10", country: "IND", city: "std:080", action, core_version: "1.2.0", bap_id: BAP_ID, bap_uri: "https://93.184.216.34/ondc", bpp_id: BPP_ID, bpp_uri: "https://bpp",
  transaction_id: randomUUID(), message_id: randomUUID(), timestamp: new Date().toISOString(), ttl: "PT30S", ...over,
});
type Ctx = ReturnType<typeof ctx>;
const post = (action: string, c: Ctx, message: unknown, o: { gateway?: string | null } = {}) => {
  const body = JSON.stringify({ context: c, message });
  return ondc.receiveInbound({ action, rawBody: body, authorization: buildAuthHeader({ body, subscriberId: BAP_ID, uniqueKeyId: "bap-k1", privateKey: bap.privateKey }), gatewayAuthorization: o.gateway });
};
const gwHeader = (c: Ctx, message: unknown, key = gw.privateKey) => buildAuthHeader({ body: JSON.stringify({ context: c, message }), subscriberId: `gw-${tag}`, uniqueKeyId: "gw-k1", privateKey: key });
const inboundRow = (c: Ctx, action: string) => prisma.ondcMessage.findFirstOrThrow({ where: { direction: "inbound", action, transactionId: c.transaction_id, messageId: c.message_id } });
const run = async (c: Ctx, action: string) => void (await processInbound((await inboundRow(c, action)).id));
const outbound = (txn: string) => prisma.ondcMessage.findMany({ where: { direction: "outbound", transactionId: txn }, orderBy: { createdAt: "asc" } });

async function makeOrder(over: { status?: string; internalOrderId?: string | null } = {}) {
  const c = ctx("confirm");
  return prisma.ondcOrder.create({
    data: {
      transactionId: c.transaction_id, messageId: c.message_id, bapId: BAP_ID, bapUri: c.bap_uri, sellerBusinessId: SELLER, totalPaise: 100_000n, items: { lines: [], breakup: [] },
      status: over.status ?? "accepted", internalOrderId: over.internalOrderId === undefined ? randomUUID() : over.internalOrderId,
      payload: { context: c, message: { order: { items: [], fulfillments: [{ id: "F1", type: "Delivery" }] } } } as object,
    },
  });
}
const issueMsg = (orderId: string, over: Record<string, unknown> = {}) => ({
  issue: { id: randomUUID(), category: "ITEM", sub_category: "ITM02", issue_type: "ISSUE", status: "OPEN", order_details: { id: orderId },
    description: { short_desc: "Steel pipes rusted", long_desc: "Half the lot arrived rusted" }, expected_response_time: { duration: "PT2H" }, expected_resolution_time: { duration: "PT48H" }, ...over },
});

beforeAll(() => {
  setJobQueue(queue);
  Object.assign(process.env, { ONDC_ENABLED: "true", ONDC_SUBSCRIBER_ID: BPP_ID, ONDC_UNIQUE_KEY_ID: "bpp-k1", ONDC_SUBSCRIBER_URL: "https://bpp.example.com/ondc", ONDC_SIGNING_PRIVATE_KEY: bpp.privateKey,
    ONDC_ENCRYPTION_PRIVATE_KEY: enc.privateKey, ONDC_ENCRYPTION_PUBLIC_KEY: enc.publicKey });
  delete process.env.ONDC_REQUIRE_GATEWAY_AUTH;
  ondc.setRegistry({
    lookup: async ({ subscriberId, uniqueKeyId }) => {
      const mk = (pub: string, type: string) => ({ subscriberId, uniqueKeyId, signingPublicKey: pub, status: "SUBSCRIBED", validFrom: null, validUntil: null, type, subscriberUrl: null });
      if (subscriberId === BAP_ID && uniqueKeyId === "bap-k1") return mk(bap.publicKey, "BAP");
      if (subscriberId === `gw-${tag}` && uniqueKeyId === "gw-k1") return mk(gw.publicKey, "BG");
      if (subscriberId === `bap-${tag}-as-gw`) return mk(bap.publicKey, "BAP");
      if (subscriberId === "flaky") throw new Error("down");
      if (subscriberId === BPP_ID) return mk(bpp.publicKey, "BPP");
      return null;
    },
  });
});
beforeEach(async () => {
  sent = [];
  ondc.setFetch(async (url, init) => { sent.push({ url, body: init.body ?? "" }); return { ok: true, status: 200, text: async () => JSON.stringify({ message: { ack: { status: "ACK" } } }) }; });
  await prisma.ondcControl.deleteMany({ where: { key: "killswitch" } });
  resetKillSwitchCache();
  process.env.ONDC_ENABLED = "true";
  disputes.enabled = true;
  disputes.openDispute.mockClear(); disputes.openDispute.mockImplementation(async () => ({ id: randomUUID() })); disputes.getDisputeForOrder.mockReset(); disputes.getDisputeForOrder.mockResolvedValue(null); disputes.withdrawDispute.mockClear();
});
afterAll(async () => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  ondc.setRegistry(undefined); ondc.setFetch(undefined); setJobQueue(undefined);
  await prisma.ondcIssue.deleteMany({ where: { bapId: BAP_ID } });
  await prisma.ondcOrder.deleteMany({ where: { sellerBusinessId: SELLER } });
  await prisma.ondcMessage.deleteMany({ where: { counterpartyId: BAP_ID } });
  await prisma.ondcControl.deleteMany({});
  await prisma.domainEvent.deleteMany({ where: { type: "OndcIssueReceived", aggregateType: "ondc_issue" } });
});

describe("gateway authentication", () => {
  const sc = { intent: { item: { descriptor: { name: "pipe" } } } };
  it("accepts /search without a gateway header when not required, and with a valid gateway signature", async () => {
    const a = ctx("search");
    expect((await post("search", a, sc)).status).toBe(200);
    const b = ctx("search");
    expect((await post("search", b, sc, { gateway: gwHeader(b, sc) })).status).toBe(200);
  });
  it("rejects a forged, non-gateway or unknown gateway signature even when not required", async () => {
    const c = ctx("search");
    expect((await post("search", c, sc, { gateway: gwHeader(c, sc, bap.privateKey) })).status).toBe(401);
    const d = ctx("search");
    const asBap = buildAuthHeader({ body: JSON.stringify({ context: d, message: sc }), subscriberId: `bap-${tag}-as-gw`, uniqueKeyId: "x", privateKey: bap.privateKey });
    expect((await post("search", d, sc, { gateway: asBap })).status).toBe(401); // registry type is BAP, not BG
    expect((await post("search", d, sc, { gateway: "garbage" })).status).toBe(401);
    const e = buildAuthHeader({ body: JSON.stringify({ context: d, message: sc }), subscriberId: "nobody", uniqueKeyId: "x", privateKey: gw.privateKey });
    expect((await post("search", d, sc, { gateway: e })).status).toBe(401);
    const f = buildAuthHeader({ body: JSON.stringify({ context: d, message: sc }), subscriberId: "flaky", uniqueKeyId: "x", privateKey: gw.privateKey });
    expect((await post("search", d, sc, { gateway: f })).status).toBe(503);
  });
  it("requires it when configured (prod default) and only for /search", async () => {
    process.env.ONDC_REQUIRE_GATEWAY_AUTH = "true";
    try {
      expect((await post("search", ctx("search"), sc)).status).toBe(401);
      expect((await post("status", ctx("status"), { order_id: randomUUID() })).status).toBe(200);
      expect(ondc.loadConfig({ ONDC_ENV: "prod" }).gatewayAuthRequired).toBe(true);
      expect(ondc.loadConfig({ ONDC_ENV: "prod", ONDC_REQUIRE_GATEWAY_AUTH: "false" }).gatewayAuthRequired).toBe(false);
    } finally { delete process.env.ONDC_REQUIRE_GATEWAY_AUTH; }
  });
});

describe("kill switch", () => {
  it("NACKs inbound, stops publishing and parks callbacks until released", async () => {
    const c = ctx("status");
    const o = await makeOrder();
    expect((await post("status", c, { order_id: o.id })).status).toBe(200);
    await ondc.setKillSwitch(true, "staff-1", "incident");
    expect((await ondc.getKillSwitch()).killed).toBe(true);
    const r = await post("search", ctx("search"), {});
    expect(r.status).toBe(503);
    expect(await ondc.publishAllCatalogs()).toBe(0);
    expect((await ondc.publishCatalog(randomUUID())).skipped).toBe("disabled");
    expect(await ondc.allProviders()).toEqual([]);
    await run(c, "status"); // parked: skipped, stays received
    expect((await inboundRow(c, "status")).status).toBe("received");
    // an outbound callback created before the switch stays pending
    await ondc.setKillSwitch(false, "staff-1");
    await run(c, "status");
    const [cb] = await outbound(c.transaction_id);
    await ondc.setKillSwitch(true, "staff-1");
    expect(await deliverCallback(cb!.id)).toBe("skipped");
    expect(sent).toHaveLength(0);
    await ondc.setKillSwitch(false, "staff-1"); // resumes: re-queues parked work
    expect(await deliverCallback(cb!.id)).toBe("sent");
    expect((await post("status", ctx("status"), { order_id: o.id })).status).toBe(200);
  });
  it("resumePending re-queues pending outbound and received inbound rows", async () => {
    const c = ctx("status");
    const o = await makeOrder();
    await post("status", c, { order_id: o.id });
    expect(await ondc.resumePending()).toBeGreaterThanOrEqual(1);
  });
});

describe("fulfilment status push", () => {
  const push = (id: string, to: string) => ondc.onOrderStatusChanged({ orderId: id, to });
  it("pushes each mapped state once, signed on_status with the Beckn fulfilment state", async () => {
    const o = await makeOrder({ status: "accepted" });
    expect(await push(o.internalOrderId!, "dispatched")).toBe(true);
    expect(await push(o.internalOrderId!, "dispatched")).toBe(false); // already there
    expect(await push(o.internalOrderId!, "delivered")).toBe(true);
    expect(await push(o.internalOrderId!, "completed")).toBe(true);
    expect(await push(o.internalOrderId!, "dispatched")).toBe(false); // never backwards
    const rows = (await outbound(o.transactionId)).filter((m) => m.action === "on_status");
    expect(rows).toHaveLength(3);
    const codes = rows.map((r) => ((r.body as { message: { order: { fulfillments: { state: { descriptor: { code: string } } }[]; state: string } } }).message.order.fulfillments[0]!.state.descriptor.code));
    expect(codes).toEqual(["Order-picked-up", "Order-delivered", "Order-delivered"]);
    for (const r of rows) expect(await deliverCallback(r.id)).toBe("sent");
    expect(sent.every((s) => s.url.endsWith("/on_status"))).toBe(true);
    expect((await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("completed");
  });
  it("confirms a created order accepted on the platform as Packed, and pushes cancellation once", async () => {
    const o = await makeOrder({ status: "created" });
    expect(await push(o.internalOrderId!, "confirmed")).toBe(true);
    const packed = (await outbound(o.transactionId)).find((m) => m.action === "on_status")!;
    expect(JSON.stringify(packed.body)).toContain("Packed");
    expect(await push(o.internalOrderId!, "cancelled")).toBe(true);
    expect(await push(o.internalOrderId!, "cancelled")).toBe(false);
    const cancelled = await prisma.ondcOrder.findUniqueOrThrow({ where: { id: o.id } });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.fulfilmentState).toBe("Cancelled");
  });
  it("ignores unmapped statuses, unknown orders, orders already decided in the inbox, and a disabled flag or kill switch", async () => {
    const o = await makeOrder({ status: "accepted" });
    expect(await push(o.internalOrderId!, "recorded")).toBe(false);
    expect(await push(randomUUID(), "dispatched")).toBe(false);
    expect(await push(o.internalOrderId!, "confirmed")).toBe(false); // already accepted via the inbox
    await ondc.setKillSwitch(true, "s");
    expect(await push(o.internalOrderId!, "dispatched")).toBe(false);
    await ondc.setKillSwitch(false, "s");
    process.env.ONDC_ENABLED = "false";
    expect(await push(o.internalOrderId!, "dispatched")).toBe(false);
    const rejected = await makeOrder({ status: "cancelled" });
    process.env.ONDC_ENABLED = "true";
    expect(await push(rejected.internalOrderId!, "cancelled")).toBe(false);
    expect(await ondc.worker.handlers.OrderStatusChanged!({ payload: { orderId: randomUUID(), to: "dispatched" } } as never)).toBeUndefined();
  });
});

describe("IGM", () => {
  it("opens a dispute, emits OndcIssueReceived once and answers on_issue; redelivery is idempotent", async () => {
    const o = await makeOrder();
    const c = ctx("issue");
    const m = issueMsg(o.id);
    expect((await post("issue", c, m)).status).toBe(200);
    await run(c, "issue");
    const issue = await prisma.ondcIssue.findFirstOrThrow({ where: { bapId: BAP_ID, issueId: m.issue.id } });
    expect(issue.disputeId).toBeTruthy();
    expect(issue.needsManual).toBe(false);
    expect(issue.expectedResponseAt.getTime() - issue.createdAt.getTime()).toBeCloseTo(2 * 3_600_000, -4);
    expect(issue.expectedResolutionAt.getTime() - issue.createdAt.getTime()).toBeCloseTo(48 * 3_600_000, -4);
    const [call] = disputes.openDispute.mock.calls;
    expect(call![1]).toMatchObject({ orderId: o.internalOrderId, type: "quality_mismatch" });
    const ev = await prisma.domainEvent.findMany({ where: { type: "OndcIssueReceived", aggregateId: issue.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ ondcOrderId: o.id, disputeId: issue.disputeId });
    const cbs = (await outbound(c.transaction_id)).filter((x) => x.action === "on_issue");
    expect(cbs).toHaveLength(1);
    expect(JSON.stringify(cbs[0]!.body)).toContain("PROCESSING");
    // same issue again (new message id): no second dispute or event, acknowledged with current state
    const c2 = ctx("issue", { transaction_id: c.transaction_id });
    await post("issue", c2, m);
    await run(c2, "issue");
    expect(disputes.openDispute).toHaveBeenCalledTimes(1);
    expect(await prisma.domainEvent.count({ where: { type: "OndcIssueReceived", aggregateId: issue.id } })).toBe(1);
  });
  it("answers issue_status and mirrors dispute escalation and resolution as on_issue_status", async () => {
    const o = await makeOrder();
    const c = ctx("issue");
    const m = issueMsg(o.id, { category: "FULFILLMENT" });
    await post("issue", c, m); await run(c, "issue");
    const issue = await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m.issue.id } });
    const cs = ctx("issue_status", { transaction_id: c.transaction_id });
    await post("issue_status", cs, { issue_id: m.issue.id }); await run(cs, "issue_status");
    expect((await outbound(c.transaction_id)).some((x) => x.action === "on_issue_status" && x.messageId === cs.message_id)).toBe(true);
    expect(await ondc.onDisputeEscalated({ disputeId: issue.disputeId! })).toBe(true);
    expect(await ondc.onDisputeEscalated({ disputeId: issue.disputeId! })).toBe(false);
    expect(await ondc.onDisputeResolved({ disputeId: issue.disputeId!, outcome: "buyer_favour", refundPaise: 25_000 })).toBe(true);
    expect(await ondc.onDisputeResolved({ disputeId: issue.disputeId!, outcome: "buyer_favour", refundPaise: 25_000 })).toBe(false);
    expect(await ondc.onDisputeResolved({ disputeId: randomUUID(), outcome: "seller_favour", refundPaise: 0 })).toBe(false);
    const resolved = (await outbound(c.transaction_id)).filter((x) => x.action === "on_issue_status").at(-1)!;
    const body = resolved.body as { message: { issue: { resolution: { action_triggered: string; refund_amount: string } } }; context: { core_version: string } };
    expect(body.message.issue.resolution).toMatchObject({ action_triggered: "REFUND", refund_amount: "250.00" });
    expect(body.context.core_version).toBe("1.2.0");
    expect((await prisma.ondcIssue.findUniqueOrThrow({ where: { id: issue.id } })).status).toBe("resolved");
    // status query after resolution carries the resolution
    const cs2 = ctx("issue_status", { transaction_id: c.transaction_id });
    await post("issue_status", cs2, { issue_id: m.issue.id }); await run(cs2, "issue_status");
    const last = (await prisma.ondcMessage.findFirstOrThrow({ where: { direction: "outbound", messageId: cs2.message_id } })).body;
    expect(JSON.stringify(last)).toContain("REFUND");
    await ondc.worker.handlers.DisputeEscalated!({ payload: { disputeId: randomUUID() } } as never);
    await ondc.worker.handlers.DisputeResolved!({ payload: { disputeId: randomUUID(), outcome: "split", refundPaise: 1 } } as never);
  });
  it("falls back to manual handling when no dispute can be opened, and staff resolve it", async () => {
    const noOrder = await makeOrder({ internalOrderId: null });
    const c1 = ctx("issue"); const m1 = issueMsg(noOrder.id);
    await post("issue", c1, m1); await run(c1, "issue");
    const i1 = await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m1.issue.id } });
    expect(i1).toMatchObject({ needsManual: true, disputeId: null });
    disputes.openDispute.mockRejectedValueOnce(new DomainError("forbidden", "off"));
    const o2 = await makeOrder(); const c2 = ctx("issue"); const m2 = issueMsg(o2.id, { category: "PAYMENT" });
    await post("issue", c2, m2); await run(c2, "issue");
    const i2 = await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m2.issue.id } });
    expect(i2.needsManual).toBe(true);
    expect((await prisma.domainEvent.findFirst({ where: { type: "OndcIssueReceived", aggregateId: i2.id } }))?.payload).toMatchObject({ disputeId: null });
    await expect(ondc.resolveIssueManually(i2.id, { action: "NO-ACTION", shortDesc: "x" })).rejects.toMatchObject({ code: "validation" });
    await ondc.resolveIssueManually(i2.id, { action: "REFUND", shortDesc: "Refund issued manually", refundPaise: 5000 });
    await expect(ondc.resolveIssueManually(i2.id, { action: "NO-ACTION", shortDesc: "again again" })).rejects.toMatchObject({ code: "conflict" });
    await expect(ondc.resolveIssueManually(randomUUID(), { action: "NO-ACTION", shortDesc: "nothing here" })).rejects.toMatchObject({ code: "not_found" });
    expect((await outbound(c2.transaction_id)).some((x) => x.action === "on_issue_status" && JSON.stringify(x.body).includes("RESOLVED"))).toBe(true);
    // an issue with a live dispute cannot be resolved by hand
    const o3 = await makeOrder(); const c3 = ctx("issue"); const m3 = issueMsg(o3.id);
    await post("issue", c3, m3); await run(c3, "issue");
    const i3 = await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m3.issue.id } });
    await expect(ondc.resolveIssueManually(i3.id, { action: "NO-ACTION", shortDesc: "manual override" })).rejects.toMatchObject({ code: "conflict" });
  });
  it("links an already-open dispute, and the complainant closing withdraws it", async () => {
    disputes.openDispute.mockRejectedValueOnce(new DomainError("conflict", "There is already an open dispute for this order."));
    disputes.getDisputeForOrder.mockResolvedValueOnce({ id: "00000000-0000-4000-8000-0000000000e2" });
    const o = await makeOrder(); const c = ctx("issue"); const m = issueMsg(o.id);
    await post("issue", c, m); await run(c, "issue");
    expect((await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m.issue.id } })).disputeId).toBe("00000000-0000-4000-8000-0000000000e2");
    const c2 = ctx("issue", { transaction_id: c.transaction_id });
    await post("issue", c2, { issue: { ...m.issue, status: "CLOSED" } }); await run(c2, "issue");
    expect(disputes.withdrawDispute).toHaveBeenCalledTimes(1);
    expect((await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m.issue.id } })).status).toBe("closed");
    // withdraw refused because already decided: still closes
    disputes.withdrawDispute.mockRejectedValueOnce(new DomainError("conflict", "no"));
    const o2 = await makeOrder(); const d = ctx("issue"); const m2 = issueMsg(o2.id);
    await post("issue", d, m2); await run(d, "issue");
    const d2 = ctx("issue", { transaction_id: d.transaction_id });
    await post("issue", d2, { issue: { ...m2.issue, status: "CLOSED" } }); await run(d2, "issue");
    expect((await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m2.issue.id } })).status).toBe("closed");
  });
  it("answers unknown orders and issues with a domain error callback", async () => {
    const c = ctx("issue");
    await post("issue", c, issueMsg(randomUUID())); await run(c, "issue");
    expect(JSON.stringify((await outbound(c.transaction_id))[0]!.body)).toContain("30004");
    const cs = ctx("issue_status");
    await post("issue_status", cs, { issue_id: "nope" }); await run(cs, "issue_status");
    expect(JSON.stringify((await outbound(cs.transaction_id))[0]!.body)).toContain("30004");
    expect((await post("issue", ctx("issue"), { issue: { id: "x" } })).status).toBe(400);
  });
  it("cascades issues past their resolution TTL once, and purges resolved payloads", async () => {
    const o = await makeOrder(); const c = ctx("issue"); const m = issueMsg(o.id);
    await post("issue", c, m); await run(c, "issue");
    const issue = await prisma.ondcIssue.findFirstOrThrow({ where: { issueId: m.issue.id } });
    expect(await ondc.escalateOverdueIssues(new Date())).toBe(0);
    const later = new Date(Date.now() + 72 * 3_600_000);
    expect(await ondc.escalateOverdueIssues(later)).toBeGreaterThanOrEqual(1);
    expect(await ondc.escalateOverdueIssues(later)).toBe(0);
    expect(JSON.stringify((await outbound(c.transaction_id)).at(-1)!.body)).toContain("CASCADED");
    expect((await ondc.listIssues({ limit: 200 }, later)).find((i) => i.id === issue.id)?.overdue).toBe(true);
    await ondc.setKillSwitch(true, "s");
    expect(await ondc.escalateOverdueIssues(later)).toBe(0);
    await ondc.setKillSwitch(false, "s");
    await ondc.onDisputeResolved({ disputeId: issue.disputeId!, outcome: "seller_favour", refundPaise: 0 });
    const cut = new Date(Date.now() + 86_400_000);
    expect(await ondc.purgeIssuePayloads(cut, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await ondc.purgeIssuePayloads(cut)).toBeGreaterThanOrEqual(1);
    expect(await ondc.purgeIssuePayloads(cut)).toBe(0);
    expect(((await prisma.ondcIssue.findUniqueOrThrow({ where: { id: issue.id } })).payload as { redactedAt?: string }).redactedAt).toBeTruthy();
  });
  it("maps IGM categories and parses ISO durations", () => {
    expect(ondc.disputeTypeFor("PAYMENT")).toBe("payment_issue");
    expect(ondc.disputeTypeFor("FULFILLMENT")).toBe("non_delivery");
    expect(ondc.disputeTypeFor("ORDER")).toBe("non_delivery");
    expect(ondc.disputeTypeFor("ITEM", "ITM01")).toBe("quantity_short");
    expect(ondc.disputeTypeFor("ITEM", "ITM03")).toBe("wrong_item");
    expect(ondc.disputeTypeFor("ITEM", "ITM05")).toBe("damaged");
    expect(ondc.disputeTypeFor("ITEM")).toBe("quality_mismatch");
    expect(ondc.disputeTypeFor("AGENT")).toBe("other");
    expect(ondc.parseIsoDuration("P1DT2H")).toBe(26 * 3_600_000);
    expect(ondc.parseIsoDuration("PT30M")).toBe(1_800_000);
    expect(ondc.parseIsoDuration("junk")).toBeNull();
    expect(ondc.parseIsoDuration("P")).toBeNull();
    expect(ondc.detMessageId("a", "b")).toBe(ondc.detMessageId("a", "b"));
  });
});

describe("evaluation and readiness", () => {
  it("measures incremental GMV and dispute load for a window", async () => {
    const from = new Date(Date.now() - 86_400_000); const to = new Date(Date.now() + 86_400_000);
    const before = await ondc.ondcEvaluation(from, to);
    expect(before.orders.total).toBeGreaterThan(0);
    expect(before.incrementalGmvPaise).toBeGreaterThan(0);
    expect(before.issues.total).toBeGreaterThan(0);
    expect(before.issues.byCategory.ITEM).toBeGreaterThan(0);
    expect(before.issuesPer100Orders).toBeGreaterThan(0);
    expect(before.gmvByMonth.length).toBeGreaterThan(0);
    expect(before.resolvedWithinTtl).not.toBeNull();
    expect(before.medianResolutionHours).not.toBeNull();
    const empty = await ondc.ondcEvaluation(new Date("2001-01-01"), new Date("2001-02-01"));
    expect(empty).toMatchObject({ orders: { total: 0 }, incrementalGmvPaise: 0, resolvedWithinTtl: null, medianResolutionHours: null, issuesPer100Orders: 0 });
  });
  it("reports the checklist from config, registry and manual items", async () => {
    process.env.ONDC_GRO_EMAIL = "gro@example.com";
    const before = await ondc.readiness();
    expect(before.items.find((i) => i.id === "subscribed")?.ok).toBe(true);
    expect(before.items.find((i) => i.id === "gro")?.ok).toBe(true);
    expect(before.items.find((i) => i.id === "disputes")?.ok).toBe(true);
    expect(before.items.find((i) => i.id === "order_sink")?.ok).toBe(false);
    expect(before.goLive).toBe(false);
    for (const c of ondc.CERT_ITEMS) await ondc.setCertItem(c.id, true, "staff", "ok");
    await ondc.setCertItem("alerts", false, "staff");
    expect((await ondc.getCertState()).legal_terms).toMatchObject({ done: true, note: "ok" });
    expect((await ondc.readiness()).manualOk).toBe(false);
    await expect(ondc.setCertItem("bogus" as never, true, "s")).rejects.toThrow();
    const noKey = await ondc.readiness({ ...ondc.loadConfig(), subscriberId: "", signingPublicKey: null });
    expect(noKey.items.find((i) => i.id === "subscribed")?.detail).toMatch(/not set/);
    const flaky = await ondc.readiness({ ...ondc.loadConfig(), subscriberId: "flaky", uniqueKeyId: "k" });
    expect(flaky.items.find((i) => i.id === "subscribed")?.detail).toMatch(/failed/);
    const missing = await ondc.readiness({ ...ondc.loadConfig(), subscriberId: "ghost", uniqueKeyId: "k" });
    expect(missing.items.find((i) => i.id === "subscribed")?.detail).toMatch(/SUBSCRIBED/);
    const wrongKey = await ondc.readiness({ ...ondc.loadConfig(), signingPublicKey: gw.publicKey });
    expect(wrongKey.items.find((i) => i.id === "subscribed")?.detail).toMatch(/differs/);
    const ov = await ondc.adminOverview();
    expect(ov.issues.open).toBeGreaterThanOrEqual(0);
  });
});
