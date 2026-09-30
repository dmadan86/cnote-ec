// Signed callbacks (on_search, on_select, ...) to the buyer app (ADR-017). The body is stored first (replayable),
// signed at delivery time (signatures are short-lived), and delivered by the ondc.callback queue with retries.
import { getJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { assertPublicHttpUrl } from "@cnote/security";
import { callbackContext, callbackOf, type BecknContext, type CallbackAction, type InboundAction } from "./beckn";
import { buildAuthHeader } from "./crypto";
import { loadConfig, type OndcConfig } from "./config";
import { httpFetch } from "./registry";
import "./types";

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

export interface CallbackInput {
  inbound: BecknContext;
  action: CallbackAction;
  message?: Record<string, unknown>;
  error?: { type: string; code: string; message: string };
  /** fresh id for unsolicited callbacks (seller-driven status changes) */
  messageId?: string;
}

/** Stores + enqueues a callback. Re-running for the same (action, transaction, message) is a no-op. */
export async function queueCallback(i: CallbackInput, cfg: OndcConfig = loadConfig()): Promise<string> {
  const context = callbackContext(cfg, i.inbound, i.action, { messageId: i.messageId });
  const body = { context, ...(i.message ? { message: i.message } : {}), ...(i.error ? { error: i.error } : {}) };
  let id: string;
  try {
    id = (await prisma.ondcMessage.create({
      data: {
        direction: "outbound", action: i.action, transactionId: context.transaction_id, messageId: context.message_id,
        counterpartyId: i.inbound.bap_id, counterpartyUri: i.inbound.bap_uri, status: "pending", body: body as object,
      },
      select: { id: true },
    })).id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const existing = await prisma.ondcMessage.findFirstOrThrow({
      where: { direction: "outbound", action: i.action, transactionId: context.transaction_id, messageId: context.message_id }, select: { id: true },
    });
    id = existing.id;
  }
  await getJobQueue().enqueue("ondc.callback", { messageId: id }, { dedupeKey: `ondc.callback:${id}` });
  return id;
}

export const callbackFor = (a: InboundAction): CallbackAction => callbackOf(a);

/** Worker handler: signs and POSTs the stored callback. Throws on transient failure so the queue retries. */
export async function deliverCallback(messageId: string, cfg: OndcConfig = loadConfig()): Promise<"sent" | "rejected" | "skipped"> {
  if (!cfg.enabled) return "skipped";
  const row = await prisma.ondcMessage.findUnique({ where: { id: messageId } });
  if (!row || row.direction !== "outbound" || row.status === "sent") return "skipped";
  if (!cfg.signingPrivateKey || !cfg.subscriberId || !cfg.uniqueKeyId) {
    await prisma.ondcMessage.update({ where: { id: row.id }, data: { status: "failed", error: "participant not configured", attempts: { increment: 1 } } });
    throw new Error("ONDC participant is not configured");
  }
  const fail = async (error: string, httpStatus?: number) => {
    await prisma.ondcMessage.update({ where: { id: row.id }, data: { status: "failed", error: error.slice(0, 500), httpStatus: httpStatus ?? null, attempts: { increment: 1 } } });
  };
  let url: URL;
  try {
    url = await assertPublicHttpUrl(`${(row.counterpartyUri ?? "").replace(/\/+$/, "")}/${row.action}`, { allowHttp: cfg.allowHttp });
  } catch {
    await fail("callback URL rejected (not a public https URL)");
    return "rejected"; // permanent: retrying cannot help
  }
  const body = JSON.stringify(row.body);
  const authorization = buildAuthHeader({ body, subscriberId: cfg.subscriberId, uniqueKeyId: cfg.uniqueKeyId, privateKey: cfg.signingPrivateKey, ttlSeconds: cfg.signatureTtlSeconds });
  let res: Awaited<ReturnType<typeof httpFetch>>;
  try {
    res = await httpFetch(url.toString(), { method: "POST", headers: { "content-type": "application/json", authorization }, body, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    await fail(e instanceof Error ? e.message : "network error");
    throw e;
  }
  const text = await res.text().catch(() => "");
  if (res.status >= 500 || res.status === 429) {
    await fail(`http ${res.status}`, res.status);
    throw new Error(`callback ${row.action} failed: ${res.status}`);
  }
  let nacked = !res.ok;
  try {
    nacked ||= (JSON.parse(text) as { message?: { ack?: { status?: string } } }).message?.ack?.status === "NACK";
  } catch {
    /* non-JSON 2xx body: treat as accepted */
  }
  if (nacked) {
    await fail(`buyer app answered NACK/http ${res.status}`, res.status);
    return "rejected"; // the BAP refused it; ops can replay after investigating
  }
  await prisma.ondcMessage.update({ where: { id: row.id }, data: { status: "sent", httpStatus: res.status, error: null, attempts: { increment: 1 } } });
  return "sent";
}

/** Ops: put a failed callback back on the queue. */
export async function replayCallback(id: string): Promise<boolean> {
  const res = await prisma.ondcMessage.updateMany({ where: { id, direction: "outbound", status: "failed" }, data: { status: "pending", error: null } });
  if (res.count === 0) return false;
  await getJobQueue().enqueue("ondc.callback", { messageId: id });
  return true;
}
