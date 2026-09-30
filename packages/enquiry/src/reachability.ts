// Buyer reachability verification (ADR-002): before an "unreachable" auto-refund is granted we ping the buyer
// (WhatsApp utility template with a one-tap reply, falling back to SMS with a short link). A response keeps the
// credit with the seller's lead; silence for 24h, or any delivery failure on our side, returns the credit.
import { emit, getJobQueue } from "@cnote/core";
import { prisma, type Match } from "@cnote/db";
import * as identity from "@cnote/identity";
import { randomBytes } from "node:crypto";
import { refundMatch } from "./leads";
import { lockRow } from "./support";

export type ReachabilityReason = "seller_reported_unreachable" | "low_intent_intake";
export type ReachabilityChannel = "whatsapp" | "sms" | "ivr";
export type ReachabilityOutcome = "responded" | "expired" | "not_found";

export const REACHABILITY_TTL_MS = 24 * 60 * 60 * 1000;
export const REACHABILITY_TEMPLATE = "cnote_reachability_check";

/** Copy for the composition root to register (WhatsApp utility template + button, MSG91 DLT SMS). {{1}} = requirement title. */
export const REACHABILITY_COPY = {
  whatsapp: {
    en: { body: "A supplier on Cnote wants to reach you about your requirement: {{1}}. Do you still need this?", button: "Yes, I still need this" },
    hi: { body: "Cnote पर एक सप्लायर आपकी ज़रूरत \"{{1}}\" के बारे में आपसे संपर्क करना चाहता है। क्या आपको अब भी इसकी ज़रूरत है?", button: "हाँ, मुझे अब भी चाहिए" },
  },
  sms: {
    en: "Cnote: a supplier wants to reach you about \"{{1}}\". Still need it? Confirm: {{2}}",
    hi: "Cnote: एक सप्लायर आपकी ज़रूरत \"{{1}}\" के बारे में संपर्क करना चाहता है। अब भी चाहिए? पुष्टि करें: {{2}}",
  },
} as const;

export interface ReachabilityMessage {
  /** E.164 */
  phone: string;
  /** one-tap button payload (WhatsApp) */
  token: string;
  /** short link for SMS: `${APP_URL}/r/<token>` */
  link: string;
  enquiryTitle: string;
  language: "en" | "hi" | string;
  template: typeof REACHABILITY_TEMPLATE;
}

/**
 * Delivery port (enquiry may not import @cnote/whatsapp: not an allowed edge). The worker composition root registers
 * an adapter that tries WhatsApp (sendToPhone with the template) and falls back to SMS. It resolves with the channel
 * used and throws when no channel could deliver.
 */
export interface ReachabilityNotifier {
  send(msg: ReachabilityMessage): Promise<{ channel: ReachabilityChannel }>;
}

let notifier: ReachabilityNotifier | null = null;
export function setReachabilityNotifier(n: ReachabilityNotifier | null): void {
  notifier = n;
}

/** REACHABILITY_CHECK_ENABLED (default true); false = seller reports refund immediately (old behaviour). */
export function reachabilityEnabled(): boolean {
  const v = process.env.REACHABILITY_CHECK_ENABLED?.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "off");
}

const appUrl = () => (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const newToken = () => randomBytes(24).toString("base64url");

/** Creates the check row (inside the caller's transaction when given). Delivery happens separately (dispatchCheck). */
export async function createCheck(
  db: Pick<typeof prisma, "reachabilityCheck">,
  enquiryId: string,
  matchId: string | null,
  now = new Date(),
): Promise<string> {
  const row = await db.reachabilityCheck.create({
    data: { enquiryId, matchId, channel: "pending", status: "sent", token: newToken(), expiresAt: new Date(now.getTime() + REACHABILITY_TTL_MS) },
  });
  return row.id;
}

async function sellerOf(matchId: string | null): Promise<string | undefined> {
  if (!matchId) return undefined;
  return (await prisma.match.findUnique({ where: { id: matchId }, select: { sellerBusinessId: true } }))?.sellerBusinessId;
}

/** Marks a still-"sent" check failed (once) and emits ReachabilityChecked(failed). Returns true if this call did it. */
async function markFailed(checkId: string, channel: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const c = await tx.reachabilityCheck.findUnique({ where: { id: checkId } });
    if (!c) return false;
    const { count } = await tx.reachabilityCheck.updateMany({ where: { id: checkId, status: "sent" }, data: { status: "failed", channel } });
    if (count === 0) return false;
    const sellerBusinessId = await sellerOf(c.matchId);
    await emit(tx, "ReachabilityChecked", { type: "enquiry", id: c.enquiryId }, {
      checkId, enquiryId: c.enquiryId, matchId: c.matchId, channel, status: "failed", ...(sellerBusinessId ? { sellerBusinessId } : {}),
    });
    return true;
  });
}

/** Sends the buyer ping for an existing check. Never throws; a delivery problem marks the check failed. Returns final status. */
export async function dispatchCheck(checkId: string): Promise<"sent" | "failed"> {
  const check = await prisma.reachabilityCheck.findUnique({ where: { id: checkId } });
  if (!check || check.status !== "sent") return check?.status === "failed" ? "failed" : "sent";
  try {
    if (!notifier) throw new Error("no reachability notifier registered");
    const enq = await prisma.enquiry.findUnique({ where: { id: check.enquiryId }, select: { title: true, buyerPersonId: true, language: true } });
    if (!enq) throw new Error("enquiry not found");
    const contact = await identity.getPersonContact(enq.buyerPersonId, { self: true });
    if (!contact?.phone) throw new Error("buyer has no phone");
    const { channel } = await notifier.send({
      phone: contact.phone, token: check.token, link: `${appUrl()}/r/${check.token}`, enquiryTitle: enq.title, language: enq.language, template: REACHABILITY_TEMPLATE,
    });
    await prisma.reachabilityCheck.updateMany({ where: { id: checkId, status: "sent" }, data: { channel } });
    return "sent";
  } catch (err) {
    console.warn("[enquiry] reachability delivery failed", checkId, (err as Error).message);
    await markFailed(checkId, "sms");
    return "failed";
  }
}

/**
 * Delivery runs in the WORKER (the process that registers the WhatsApp/SMS notifier), never inline in the web/seller/API
 * request that created the check: otherwise those processes would have no notifier, every check would "fail", and the
 * refund would be granted without ever asking the buyer.
 */
export const REACHABILITY_DISPATCH_TOPIC = "enquiry.reachability_dispatch";
declare module "@cnote/core" {
  interface JobTopics {
    "enquiry.reachability_dispatch": { checkId: string };
  }
}

let dispatchMode: "queue" | "inline" = "queue";
/** Tests only: deliver in-process instead of via the worker queue. Production always queues. */
export function setReachabilityDispatchMode(mode: "queue" | "inline"): void {
  dispatchMode = mode;
}

export async function enqueueDispatch(checkId: string): Promise<void> {
  if (dispatchMode === "inline") return handleDispatchJob(checkId);
  await getJobQueue().enqueue(REACHABILITY_DISPATCH_TOPIC, { checkId }, { dedupeKey: `reach:${checkId}` });
}

/** Queue consumer: deliver, and settle immediately if delivery failed on our side (never punish the seller). */
export async function handleDispatchJob(checkId: string): Promise<void> {
  if ((await dispatchCheck(checkId)) === "failed") await resolveReachabilityCheck(checkId);
}

/** Public entry: create a check (optionally tied to a seller's "unreachable" report) and queue its delivery. */
export async function startReachabilityCheck(
  enquiryId: string,
  opts: { matchId?: string; reason: ReachabilityReason },
): Promise<{ checkId: string; status: "queued"; reason: ReachabilityReason }> {
  const checkId = await createCheck(prisma, enquiryId, opts.matchId ?? null);
  await enqueueDispatch(checkId);
  return { checkId, status: "queued", reason: opts.reason };
}

/**
 * Buyer confirmed. Idempotent and single-use: the first response before expiry wins (status → responded, event
 * emitted once); later calls return the same outcome. Expired/failed checks answer "expired".
 */
export async function recordReachabilityResponse(token: string, now = new Date()): Promise<ReachabilityOutcome> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return "not_found";
  return prisma.$transaction(async (tx) => {
    const c = await tx.reachabilityCheck.findUnique({ where: { token } });
    if (!c) return "not_found";
    if (c.status === "responded") return "responded";
    if (c.status !== "sent" || c.expiresAt <= now) return "expired";
    const { count } = await tx.reachabilityCheck.updateMany({ where: { id: c.id, status: "sent", expiresAt: { gt: now } }, data: { status: "responded", respondedAt: now } });
    if (count === 0) return (await tx.reachabilityCheck.findUnique({ where: { id: c.id } }))?.status === "responded" ? "responded" : "expired";
    const m = c.matchId ? await tx.match.findUnique({ where: { id: c.matchId }, select: { sellerBusinessId: true } }) : null;
    await emit(tx, "ReachabilityChecked", { type: "enquiry", id: c.enquiryId }, {
      checkId: c.id, enquiryId: c.enquiryId, matchId: c.matchId, channel: c.channel, status: "responded", ...(m ? { sellerBusinessId: m.sellerBusinessId } : {}),
    });
    return "responded";
  });
}

/** Refund the held match (once: gated on the match still being "accepted", under its row lock). */
async function refundHeld(matchId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await lockRow(tx, "matches", matchId);
    const m: Match | null = await tx.match.findUnique({ where: { id: matchId } });
    if (!m || m.status !== "accepted") return false;
    await refundMatch(tx, m, "buyer_unreachable");
    return true;
  });
}

/** Resolves one check: expired-without-response → no_response; failed → (already marked). Refunds the held match. */
export async function resolveReachabilityCheck(checkId: string, now = new Date()): Promise<"refunded" | "none"> {
  const c = await prisma.reachabilityCheck.findUnique({ where: { id: checkId } });
  if (!c) return "none";
  if (c.status === "sent" && c.expiresAt <= now) {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.reachabilityCheck.updateMany({ where: { id: c.id, status: "sent", expiresAt: { lte: now } }, data: { status: "no_response" } });
      if (count === 0) return;
      const m = c.matchId ? await tx.match.findUnique({ where: { id: c.matchId }, select: { sellerBusinessId: true } }) : null;
      await emit(tx, "ReachabilityChecked", { type: "enquiry", id: c.enquiryId }, {
        checkId: c.id, enquiryId: c.enquiryId, matchId: c.matchId, channel: c.channel, status: "no_response", ...(m ? { sellerBusinessId: m.sellerBusinessId } : {}),
      });
    });
  }
  const fresh = await prisma.reachabilityCheck.findUnique({ where: { id: checkId } });
  if (!fresh?.matchId || (fresh.status !== "no_response" && fresh.status !== "failed")) return "none";
  return (await refundHeld(fresh.matchId)) ? "refunded" : "none";
}

/** Job (every 10 min): resolves expired and failed checks. Safe under concurrent runs. Returns number refunded. */
export async function resolveReachabilityChecks(now = new Date()): Promise<number> {
  const expired = await prisma.reachabilityCheck.findMany({ where: { status: "sent", expiresAt: { lte: now } }, orderBy: { expiresAt: "asc" }, take: 200 });
  const failed = await prisma.reachabilityCheck.findMany({ where: { status: { in: ["failed", "no_response"] }, matchId: { not: null } }, orderBy: { createdAt: "desc" }, take: 200 });
  const open = new Set((await prisma.match.findMany({ where: { id: { in: failed.map((c) => c.matchId!) }, status: "accepted" }, select: { id: true } })).map((m) => m.id));
  const due = [...expired, ...failed.filter((c) => open.has(c.matchId!))];
  let n = 0;
  for (const c of due) if ((await resolveReachabilityCheck(c.id, now).catch((e) => (console.error("[enquiry] reachability resolve failed", c.id, e), "none"))) === "refunded") n++;
  return n;
}

/** Pending (buyer-check-in-flight) state per match, for the seller lead card. */
export async function pendingChecksByMatch(matchIds: string[], now = new Date()): Promise<Map<string, { expiresAt: string }>> {
  if (!matchIds.length) return new Map();
  const rows = await prisma.reachabilityCheck.findMany({ where: { matchId: { in: matchIds }, status: "sent", expiresAt: { gt: now } } });
  return new Map(rows.map((r) => [r.matchId!, { expiresAt: r.expiresAt.toISOString() }]));
}
