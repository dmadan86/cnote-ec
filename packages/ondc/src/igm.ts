// ONDC IGM: issue & grievance management, seller-side (ADR-021, ADR-013). The network buyer app POSTs `issue` /
// `issue_status`; we ACK, then answer with `on_issue` / `on_issue_status`. Each issue opens a dispute through the
// @cnote/disputes public API (the ONDC system buyer business is the opener, the seller is the respondent) and dispute
// progress/resolution is mirrored back to the network as unsolicited on_issue_status with deterministic message ids
// (idempotent per issue + state). IGM TTLs: response (default PT1H) and resolution (default PT24H) come from the request.
import { createHash } from "node:crypto";
import { DomainError, emit } from "@cnote/core";
import { prisma } from "@cnote/db";
import { getDisputeForOrder, openDispute, withdrawDispute, type DisputeTypeName } from "@cnote/disputes";
import { ensureSystemBuyerBusiness } from "@cnote/identity";
import { issueMessage, issueStatusMessage, type BecknContext } from "./beckn";
import { loadConfig, type OndcConfig } from "./config";
import { isKilled } from "./killswitch";
import { queueCallback } from "./outbound";
import { DOMAIN_ERRORS } from "./quote";

const UUID = /^[0-9a-f-]{36}$/i;
const ZERO_PERSON = "00000000-0000-0000-0000-000000000000";
const isUniqueViolation = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";

export type RespondentAction = "PROCESSING" | "CASCADED" | "RESOLVED" | "NEED-MORE-INFO";
export type ResolutionAction = "REFUND" | "REPLACEMENT" | "NO-ACTION" | "RESOLVE-PROCESS";
interface StoredAction { respondent_action: RespondentAction; short_desc: string; updated_at: string; cascaded_level?: number }
interface StoredState { actions: StoredAction[]; resolution?: { short_desc: string; long_desc: string; action_triggered: ResolutionAction; refund_amount?: string } }

/** ISO 8601 duration (PnDTnHnMnS) to ms; null when unparseable. */
export function parseIsoDuration(v: string | undefined | null): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v ?? "");
  if (!m || v === "P" || v?.endsWith("T")) return null;
  const [d, h, mi, s] = [1, 2, 3, 4].map((i) => Number(m[i] ?? 0));
  return (((d! * 24 + h!) * 60 + mi!) * 60 + s!) * 1000;
}

/** Deterministic uuid so a redelivered/replayed event maps to the same Beckn message_id (outbound rows dedupe on it). */
export function detMessageId(...parts: string[]): string {
  const h = createHash("sha256").update(`ondc:${parts.join(":")}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/**
 * IGM category / sub-category to dispute type. Best-effort mapping of the IGM 1.0 retail codes; reconcile against the
 * ONDC IGM sheet during certification. Unknown -> "other" (a human decides).
 */
export function disputeTypeFor(category: string, sub?: string | null): DisputeTypeName {
  const c = category.toUpperCase();
  const s = (sub ?? "").toUpperCase();
  if (c === "PAYMENT") return "payment_issue";
  if (c === "FULFILLMENT") return "non_delivery";
  if (c === "ITEM") {
    if (s === "ITM01" || s === "ITM04") return "quantity_short";
    if (s === "ITM02") return "quality_mismatch";
    if (s === "ITM03") return "wrong_item";
    if (s === "ITM05" || s === "ITM06") return "damaged";
    return "quality_mismatch";
  }
  if (c === "ORDER") return "non_delivery";
  return "other";
}

const respondentAction = (cfg: OndcConfig, a: StoredAction) => ({
  respondent_action: a.respondent_action,
  short_desc: a.short_desc,
  updated_at: a.updated_at,
  updated_by: {
    org: { name: `${cfg.subscriberId}::${cfg.domains[0] ?? ""}` },
    contact: { phone: cfg.groPhone || undefined, email: cfg.groEmail || undefined },
    person: { name: cfg.groName },
  },
  ...(a.cascaded_level ? { cascaded_level: a.cascaded_level } : {}),
});

const stateOf = (r: { resolution: unknown }): StoredState => {
  const s = r.resolution as StoredState | null;
  return s && Array.isArray(s.actions) ? s : { actions: [] };
};

type IssueRow = NonNullable<Awaited<ReturnType<typeof prisma.ondcIssue.findFirst>>>;

/** The on_issue / on_issue_status `issue` object for our current state. */
export function issueToBeckn(row: IssueRow, cfg: OndcConfig = loadConfig(), withResolution = false): Record<string, unknown> {
  const st = stateOf(row);
  return {
    id: row.issueId,
    issue_actions: { respondent_actions: st.actions.map((a) => respondentAction(cfg, a)) },
    ...(withResolution && st.resolution ? { resolution: st.resolution } : {}),
    ...(withResolution ? {
      resolution_provider: {
        respondent_info: {
          type: "TRANSACTION-COUNSELLOR-NETWORK-PARTICIPANT",
          organization: { org: { name: cfg.subscriberId }, contact: { phone: cfg.groPhone || undefined, email: cfg.groEmail || undefined }, person: { name: cfg.groName } },
          resolution_support: { gro_contact: { person: { name: cfg.groName }, contact: { phone: cfg.groPhone || undefined, email: cfg.groEmail || undefined } } },
        },
      },
    } : {}),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const ctxOf = (row: IssueRow): BecknContext => (row.payload as { context: BecknContext }).context;

async function pushStatus(row: IssueRow, key: string, cfg: OndcConfig, withResolution: boolean): Promise<void> {
  await queueCallback({
    inbound: ctxOf(row), action: "on_issue_status", messageId: detMessageId(row.id, key), coreVersion: ctxOf(row).core_version ?? "1.0.0",
    message: { issue: issueToBeckn(row, cfg, withResolution) },
  }, cfg);
}

async function addAction(id: string, a: Omit<StoredAction, "updated_at">, extra: Record<string, unknown> = {}): Promise<IssueRow> {
  const row = await prisma.ondcIssue.findUniqueOrThrow({ where: { id } });
  const st = stateOf(row);
  st.actions.push({ ...a, updated_at: new Date().toISOString() });
  return prisma.ondcIssue.update({ where: { id }, data: { resolution: st as object, respondentAction: a.respondent_action, ...extra } });
}

const ACTIVE = ["open", "processing"];

// ---- inbound ---------------------------------------------------------------------------------
/** Worker side of `issue`: idempotent by (bap_id, issue id). Opens (or links) a dispute, emits OndcIssueReceived once, sends on_issue. */
export async function handleIssue(body: { context: BecknContext; message: unknown }, cfg: OndcConfig = loadConfig()): Promise<void> {
  const { issue } = issueMessage.parse(body.message);
  const ctx = body.context;
  const reply = (message: Record<string, unknown>) => queueCallback({ inbound: ctx, action: "on_issue", message, coreVersion: ctx.core_version ?? "1.0.0" }, cfg);
  const orderRef = issue.order_details.id;
  const order = UUID.test(orderRef) ? await prisma.ondcOrder.findUnique({ where: { id: orderRef } }) : null;
  if (!order || order.bapId !== ctx.bap_id) {
    await queueCallback({ inbound: ctx, action: "on_issue", coreVersion: ctx.core_version ?? "1.0.0", error: DOMAIN_ERRORS.orderNotFound }, cfg);
    return;
  }

  const now = new Date();
  const key = { bapId_issueId: { bapId: ctx.bap_id, issueId: issue.id } };
  let row = await prisma.ondcIssue.findUnique({ where: key });
  if (row) {
    // complainant update: closing withdraws our side of the dispute; anything else is just re-acknowledged
    if (issue.status?.toUpperCase() === "CLOSED" && ACTIVE.includes(row.status)) row = await closeByComplainant(row);
    await reply({ issue: issueToBeckn(row, cfg) });
    return;
  }
  const respMs = parseIsoDuration(issue.expected_response_time?.duration) ?? parseIsoDuration(cfg.igmResponseTtl) ?? 3_600_000;
  const resoMs = parseIsoDuration(issue.expected_resolution_time?.duration) ?? parseIsoDuration(cfg.igmResolutionTtl) ?? 86_400_000;
  const short = issue.description?.short_desc ?? "";
  const long = issue.description?.long_desc ?? "";
  try {
    row = await prisma.ondcIssue.create({
      data: {
        issueId: issue.id, transactionId: ctx.transaction_id, bapId: ctx.bap_id, bapUri: ctx.bap_uri, ondcOrderId: order.id, sellerBusinessId: order.sellerBusinessId,
        category: issue.category, subCategory: issue.sub_category ?? null, issueType: issue.issue_type ?? "ISSUE", description: `${short}\n${long}`.trim().slice(0, 4000),
        expectedResponseAt: new Date(now.getTime() + respMs), expectedResolutionAt: new Date(now.getTime() + resoMs), payload: body as object,
      },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    row = await prisma.ondcIssue.findUniqueOrThrow({ where: key }); // concurrent duplicate
  }
  if (!row.disputeId && !row.needsManual) row = await linkDispute(row, order.internalOrderId);
  row = await prisma.$transaction(async (tx) => {
    const res = await tx.ondcIssue.updateMany({ where: { id: row!.id, receivedEmittedAt: null }, data: { receivedEmittedAt: new Date() } });
    if (res.count === 1) await emit(tx, "OndcIssueReceived", { type: "ondc_issue", id: row!.id }, { issueId: row!.id, ondcOrderId: order.id, disputeId: row!.disputeId });
    return tx.ondcIssue.findUniqueOrThrow({ where: { id: row!.id } });
  });
  if (!row.respondedAt) {
    row = await addAction(row.id, {
      respondent_action: "PROCESSING",
      short_desc: row.disputeId ? "Issue received and under review by the seller's dispute desk." : "Issue received; our grievance team is reviewing it manually.",
    }, { respondedAt: new Date(), status: "processing" });
  }
  await reply({ issue: issueToBeckn(row, cfg) });
}

/** Opens a dispute (or links the one already open for the order). Never throws for domain refusals: those need staff. */
async function linkDispute(row: IssueRow, internalOrderId: string | null): Promise<IssueRow> {
  const manual = () => prisma.ondcIssue.update({ where: { id: row.id }, data: { needsManual: true } });
  if (!internalOrderId) return manual(); // sink not wired / mirror failed: no platform order to dispute
  const actor = { personId: ZERO_PERSON, businessId: await ensureSystemBuyerBusiness("ondc", "ONDC network buyer") };
  try {
    const text = `[ONDC ${row.category}${row.subCategory ? `/${row.subCategory}` : ""}] ${row.description}`.padEnd(10, ".").slice(0, 3900);
    const d = await openDispute(actor, { orderId: internalOrderId, type: disputeTypeFor(row.category, row.subCategory), description: text, language: "en" });
    return prisma.ondcIssue.update({ where: { id: row.id }, data: { disputeId: d.id } });
  } catch (e) {
    if (!(e instanceof DomainError)) throw e; // infra failure: queue retries
    if (e.code === "conflict") {
      const existing = await getDisputeForOrder(actor, internalOrderId).catch(() => null);
      if (existing) return prisma.ondcIssue.update({ where: { id: row.id }, data: { disputeId: existing.id } });
    }
    return manual(); // disputes disabled, order not yet disputable, ...
  }
}

async function closeByComplainant(row: IssueRow): Promise<IssueRow> {
  if (row.disputeId) {
    try {
      const actor = { personId: ZERO_PERSON, businessId: await ensureSystemBuyerBusiness("ondc", "ONDC network buyer") };
      await withdrawDispute(actor, row.disputeId);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e; // already decided/closed: nothing to withdraw
    }
  }
  const closed = await prisma.ondcIssue.update({ where: { id: row.id }, data: { status: "closed", resolvedAt: new Date() } });
  return closed;
}

export async function handleIssueStatus(body: { context: BecknContext; message: unknown }, cfg: OndcConfig = loadConfig()): Promise<void> {
  const { issue_id } = issueStatusMessage.parse(body.message);
  const ctx = body.context;
  const row = await prisma.ondcIssue.findUnique({ where: { bapId_issueId: { bapId: ctx.bap_id, issueId: issue_id } } });
  if (!row) return void (await queueCallback({ inbound: ctx, action: "on_issue_status", coreVersion: ctx.core_version ?? "1.0.0", error: DOMAIN_ERRORS.orderNotFound }, cfg));
  await queueCallback({ inbound: ctx, action: "on_issue_status", coreVersion: ctx.core_version ?? "1.0.0", message: { issue: issueToBeckn(row, cfg, row.status === "resolved") } }, cfg);
}

// ---- dispute -> network mirror (event handlers) ----------------------------------------------
const live = async (cfg: OndcConfig) => cfg.enabled && !(await isKilled());

/** DisputeEscalated: tell the network the case moved to human review. Idempotent (only while the issue is active). */
export async function onDisputeEscalated(p: { disputeId: string }, cfg: OndcConfig = loadConfig()): Promise<boolean> {
  if (!(await live(cfg))) return false;
  const row = await prisma.ondcIssue.findFirst({ where: { disputeId: p.disputeId, status: { in: ACTIVE } } });
  if (!row || stateOf(row).actions.some((a) => a.short_desc.startsWith("Escalated"))) return false;
  const next = await addAction(row.id, { respondent_action: "PROCESSING", short_desc: "Escalated to human review by the grievance team." });
  await pushStatus(next, "escalated", cfg, false);
  return true;
}

const REFUNDING = new Set(["buyer_favour", "split"]);

/** DisputeResolved: mirror the outcome as on_issue_status RESOLVED with the resolution. Idempotent (first resolution wins). */
export async function onDisputeResolved(p: { disputeId: string; outcome: string; refundPaise: number }, cfg: OndcConfig = loadConfig()): Promise<boolean> {
  const row = await prisma.ondcIssue.findFirst({ where: { disputeId: p.disputeId } });
  if (!row) return false;
  if (row.status === "resolved" || row.status === "closed") return false;
  const refund = REFUNDING.has(p.outcome) && p.refundPaise > 0;
  return applyResolution(row, {
    action: refund ? "REFUND" : "NO-ACTION",
    shortDesc: p.outcome === "withdrawn" ? "Issue withdrawn." : refund ? "Refund approved by dispute resolution." : "Reviewed: no action required.",
    longDesc: `Dispute outcome: ${p.outcome}.`,
    refundPaise: refund ? p.refundPaise : undefined,
  }, cfg);
}

export interface ManualResolution { action: ResolutionAction; shortDesc: string; longDesc?: string; refundPaise?: number }

async function applyResolution(row: IssueRow, r: ManualResolution, cfg: OndcConfig): Promise<boolean> {
  const claimed = await prisma.ondcIssue.updateMany({ where: { id: row.id, status: { in: ACTIVE } }, data: { status: "resolved", resolvedAt: new Date() } });
  if (claimed.count === 0) return false;
  const fresh = await prisma.ondcIssue.findUniqueOrThrow({ where: { id: row.id } });
  const st = stateOf(fresh);
  st.actions.push({ respondent_action: "RESOLVED", short_desc: r.shortDesc.slice(0, 500), updated_at: new Date().toISOString() });
  st.resolution = {
    short_desc: r.shortDesc.slice(0, 500), long_desc: (r.longDesc ?? r.shortDesc).slice(0, 2000), action_triggered: r.action,
    ...(r.refundPaise ? { refund_amount: (r.refundPaise / 100).toFixed(2) } : {}),
  };
  const done = await prisma.ondcIssue.update({ where: { id: row.id }, data: { resolution: st as object, respondentAction: "RESOLVED" } });
  if (await live(cfg)) await pushStatus(done, "resolved", cfg, true);
  return true;
}

/** Staff resolve an issue that has no dispute behind it (needsManual) or override; audited by the admin action. */
export async function resolveIssueManually(id: string, r: ManualResolution, cfg: OndcConfig = loadConfig()): Promise<void> {
  const row = UUID.test(id) ? await prisma.ondcIssue.findUnique({ where: { id } }) : null;
  if (!row) throw new DomainError("not_found", "Issue not found.");
  if (r.shortDesc.trim().length < 5) throw new DomainError("validation", "Add a short resolution note.");
  if (row.disputeId && !row.needsManual) throw new DomainError("conflict", "This issue is handled through its dispute; resolve the dispute instead.");
  if (!(await applyResolution(row, r, cfg))) throw new DomainError("conflict", "This issue is already resolved.");
}

// ---- TTLs -------------------------------------------------------------------------------------
/** Job: issues past their resolution TTL are cascaded to the next level (L2 / GRO) once, and the network is told. */
export async function escalateOverdueIssues(now: Date = new Date(), cfg: OndcConfig = loadConfig()): Promise<number> {
  if (!(await live(cfg))) return 0;
  const due = await prisma.ondcIssue.findMany({ where: { status: { in: ACTIVE }, cascadedAt: null, expectedResolutionAt: { lt: now } }, take: 100, orderBy: { expectedResolutionAt: "asc" } });
  let n = 0;
  for (const row of due) {
    const claimed = await prisma.ondcIssue.updateMany({ where: { id: row.id, cascadedAt: null }, data: { cascadedAt: now } });
    if (claimed.count === 0) continue;
    const next = await addAction(row.id, { respondent_action: "CASCADED", short_desc: "Resolution time exceeded; escalated to the next level.", cascaded_level: 2 });
    await pushStatus(next, "cascaded", cfg, false);
    n++;
  }
  return n;
}

/** DPDP (ADR-010): complainant contact lives in the issue payload; keep only the Beckn context after the window. */
export async function purgeIssuePayloads(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const rows = await prisma.ondcIssue.findMany({ where: { status: { in: ["resolved", "closed"] }, updatedAt: { lt: before } }, select: { id: true, payload: true }, take: 1000 });
  let n = 0;
  for (const r of rows) {
    const p = r.payload as { context?: unknown; redactedAt?: string };
    if (p.redactedAt) continue;
    n++;
    if (!opts.dryRun) await prisma.ondcIssue.update({ where: { id: r.id }, data: { payload: { context: p.context, redactedAt: new Date().toISOString() } as object } });
  }
  return n;
}

// ---- admin reads ------------------------------------------------------------------------------
export interface IssueView {
  id: string; issueId: string; bapId: string; ondcOrderId: string | null; category: string; subCategory: string | null; status: string; respondentAction: string | null;
  disputeId: string | null; needsManual: boolean; overdue: boolean; expectedResolutionAt: string; createdAt: string; description: string;
}

export async function listIssues(opts: { status?: string; limit?: number } = {}, now: Date = new Date()): Promise<IssueView[]> {
  const rows = await prisma.ondcIssue.findMany({ where: opts.status ? { status: opts.status } : {}, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: Math.min(200, opts.limit ?? 50) });
  return rows.map((r) => ({
    id: r.id, issueId: r.issueId, bapId: r.bapId, ondcOrderId: r.ondcOrderId, category: r.category, subCategory: r.subCategory, status: r.status, respondentAction: r.respondentAction,
    disputeId: r.disputeId, needsManual: r.needsManual, overdue: ACTIVE.includes(r.status) && r.expectedResolutionAt < now, expectedResolutionAt: r.expectedResolutionAt.toISOString(),
    createdAt: r.createdAt.toISOString(), description: r.description.slice(0, 300),
  }));
}
