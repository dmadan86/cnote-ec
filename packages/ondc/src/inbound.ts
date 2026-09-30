// Inbound ONDC requests (ADR-017): authenticate, validate, store idempotently, ACK immediately, process async.
// The HTTP layer only forwards (action, raw body, headers) and relays {status, body}.
import { getJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import {
  ACK, ERROR_CODES, cityAllowed, envelopeSchema, isInboundAction, nack, orderIdMessage, orderMessage, searchMessage, type BecknContext,
} from "./beckn";
import { loadConfig, type OndcConfig } from "./config";
import { parseAuthHeader, verifyAuthSignature } from "./crypto";
import { getRegistry } from "./registry";
import "./types";

export interface InboundResult { status: number; body: unknown }
export const MAX_BODY_BYTES = 512_000;

const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

export async function receiveInbound(input: { action: string; rawBody: string; authorization?: string | null }, cfg: OndcConfig = loadConfig()): Promise<InboundResult> {
  if (!cfg.enabled || !isInboundAction(input.action)) return { status: 404, body: { error: "not found" } };
  const action = input.action;
  if (input.rawBody.length > MAX_BODY_BYTES) return { status: 413, body: nack(ERROR_CODES.badRequest, "payload too large") };

  let json: unknown;
  try {
    json = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: nack(ERROR_CODES.badRequest, "not JSON") };
  }
  const env = envelopeSchema.safeParse(json);
  if (!env.success || env.data.context.action !== action) return { status: 400, body: nack(ERROR_CODES.badRequest, "context/message invalid") };
  const context = env.data.context as BecknContext;

  // 1. authenticate: the signer must be the BAP named in the context, active in the registry
  const auth = parseAuthHeader(input.authorization);
  if (!auth || auth.subscriberId !== context.bap_id) return { status: 401, body: nack(ERROR_CODES.invalidSignature) };
  let entry;
  try {
    entry = await getRegistry().lookup({ subscriberId: auth.subscriberId, uniqueKeyId: auth.uniqueKeyId });
  } catch {
    return { status: 503, body: nack(ERROR_CODES.unavailable, "registry lookup failed") };
  }
  if (!entry || !verifyAuthSignature(auth, input.rawBody, entry.signingPublicKey).ok) return { status: 401, body: nack(ERROR_CODES.invalidSignature) };

  // 2. context policy
  if (!cfg.domains.includes(context.domain) || !cityAllowed(cfg, context.city)) return { status: 400, body: nack(ERROR_CODES.wrongDomain) };
  if (action !== "search" && context.bpp_id !== cfg.subscriberId) return { status: 400, body: nack(ERROR_CODES.notForUs) };

  // 3. per-action message shape
  const schema = action === "search" ? searchMessage : action === "select" || action === "init" || action === "confirm" ? orderMessage : orderIdMessage;
  if (!schema.safeParse(env.data.message).success) return { status: 400, body: nack(ERROR_CODES.badRequest, `${action} message invalid`) };

  // 4. store idempotently (transaction_id + message_id + action), then queue
  const key = { direction: "inbound", action, transactionId: context.transaction_id, messageId: context.message_id };
  let id: string;
  try {
    id = (await prisma.ondcMessage.create({
      data: { ...key, counterpartyId: context.bap_id, counterpartyUri: context.bap_uri, status: "received", body: json as object },
      select: { id: true },
    })).id;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const prev = await prisma.ondcMessage.findFirstOrThrow({ where: key, select: { id: true, status: true } });
    if (prev.status !== "failed") return { status: 200, body: ACK }; // duplicate delivery: already accepted
    id = prev.id;
    await prisma.ondcMessage.update({ where: { id }, data: { status: "received", error: null } });
  }
  try {
    await getJobQueue().enqueue("ondc.inbound", { messageId: id }, { dedupeKey: `ondc.inbound:${id}:${Math.floor(Date.now() / 60_000)}` });
  } catch {
    await prisma.ondcMessage.update({ where: { id }, data: { status: "failed", error: "enqueue failed" } });
    return { status: 503, body: nack(ERROR_CODES.unavailable) };
  }
  return { status: 200, body: ACK };
}
