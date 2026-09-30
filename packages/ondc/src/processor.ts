// Async processing of stored inbound requests -> signed callbacks (ADR-017). Idempotent: a redelivered job
// re-derives the same callback (queueCallback dedupes on action+transaction+message).
import { prisma } from "@cnote/db";
import {
  callbackOf, itemCount, orderIdMessage, orderMessage, searchMessage, type BecknContext, type InboundAction,
} from "./beckn";
import { catalogForIntent, providerFor } from "./catalog";
import { loadConfig, type OndcConfig } from "./config";
import { orderToBeckn, receiveOrder, transitionOrder, type OndcOrderStatus } from "./orders";
import { queueCallback } from "./outbound";
import { DOMAIN_ERRORS, quoteOrder } from "./quote";

const UUID = /^[0-9a-f-]{36}$/i;

/** Worker handler for "ondc.inbound". */
export async function processInbound(messageId: string, cfg: OndcConfig = loadConfig()): Promise<"processed" | "skipped"> {
  if (!cfg.enabled) return "skipped";
  const row = await prisma.ondcMessage.findUnique({ where: { id: messageId } });
  if (!row || row.direction !== "inbound" || row.status === "processed") return "skipped";
  const body = row.body as { context: BecknContext; message: unknown };
  try {
    await handle(row.action as InboundAction, body, cfg);
  } catch (e) {
    await prisma.ondcMessage.update({ where: { id: row.id }, data: { status: "failed", error: (e instanceof Error ? e.message : "error").slice(0, 500), attempts: { increment: 1 } } });
    throw e; // queue retries with backoff, then dead-letters
  }
  await prisma.ondcMessage.update({ where: { id: row.id }, data: { status: "processed", error: null, attempts: { increment: 1 } } });
  return "processed";
}

async function handle(action: InboundAction, body: { context: BecknContext; message: unknown }, cfg: OndcConfig): Promise<void> {
  const { context } = body;
  const cb = callbackOf(action);
  const reply = (message: Record<string, unknown>) => queueCallback({ inbound: context, action: cb, message }, cfg);
  const fail = (error: { type: string; code: string; message: string }) => queueCallback({ inbound: context, action: cb, error }, cfg);

  switch (action) {
    case "search": {
      const m = searchMessage.parse(body.message);
      const catalog = await catalogForIntent({ text: m.intent?.item?.descriptor?.name, categoryId: m.intent?.category?.id, providerId: m.intent?.provider?.id }, cfg);
      if (catalog) await reply({ catalog }); // no match => stay silent, as gateways expect
      return;
    }
    case "select":
    case "init": {
      const { order } = orderMessage.parse(body.message);
      const q = quoteOrder(await providerFor(order.provider.id, cfg), order.items);
      if ("error" in q) return void (await fail(q.error));
      const echo = { provider: { id: order.provider.id }, items: order.items.map((i) => ({ id: i.id, fulfillment_id: i.fulfillment_id, quantity: { selected: { count: itemCount(i) } } })) };
      if (action === "select") return void (await reply({ order: { ...echo, quote: q.quote.message } }));
      return void (await reply({ order: { ...echo, billing: order.billing, fulfillments: order.fulfillments, quote: q.quote.message, payment: { type: "POST-FULFILLMENT", collected_by: "BPP", status: "NOT-PAID" } } }));
    }
    case "confirm": {
      const { order } = orderMessage.parse(body.message);
      const q = quoteOrder(await providerFor(order.provider.id, cfg), order.items);
      if ("error" in q) return void (await fail(q.error));
      const { order: saved } = await receiveOrder({ context, body, sellerBusinessId: order.provider.id, quote: q.quote });
      return void (await reply({ order: orderToBeckn(saved) }));
    }
    case "status": {
      const { order_id } = orderIdMessage.parse(body.message);
      const o = UUID.test(order_id) ? await prisma.ondcOrder.findUnique({ where: { id: order_id } }) : null;
      if (!o || o.bapId !== context.bap_id) return void (await fail(DOMAIN_ERRORS.orderNotFound));
      return void (await reply({ order: orderToBeckn(o) }));
    }
    case "cancel": {
      const { order_id, cancellation_reason_id } = orderIdMessage.parse(body.message);
      const o = UUID.test(order_id) ? await prisma.ondcOrder.findUnique({ where: { id: order_id } }) : null;
      if (!o || o.bapId !== context.bap_id) return void (await fail(DOMAIN_ERRORS.orderNotFound));
      let cur = o;
      if (o.status !== "cancelled") {
        if (!(["created", "accepted"] as OndcOrderStatus[]).includes(o.status as OndcOrderStatus)) return void (await fail(DOMAIN_ERRORS.invalidState));
        cur = await transitionOrder(o.id, ["created", "accepted"], "cancelled", { cancelReason: cancellation_reason_id ?? "buyer" });
      }
      return void (await reply({ order: orderToBeckn(cur) }));
    }
  }
}
