// Standing mandates (ADR-020). A mandate is the principal's explicit, revocable, logged instruction to their agent.
//  - explicit opt-in: creating one needs `optIn: true` (recorded as consentedAt)
//  - auto-accept is OFF by default; turning it on needs its own consent and a limit tighter than (or equal to) the hard bounds
//  - revocable at any time (open negotiations of the mandate are withdrawn), every change is appended to AgentMandateChange
import { DomainError } from "@cnote/core";
import { prisma, type AgentMandate, type DbClient } from "@cnote/db";
import * as negotiation from "@cnote/negotiation";
import { z } from "zod";
import { big, isUuid, json, logActivity, num, type Actor, type Via } from "./common";
import { withdrawOpenNegotiations } from "./negotiation";
import type { Side } from "./protocol";

const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const paise = z.number().int().positive().max(10_000_000_000_00);
const isoInstant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Enter a valid date");

const base = {
  name: z.string().trim().min(3, "Give the mandate a name (3+ characters)").max(80),
  categorySlug: optText(100),
  maxRounds: z.number().int().min(2).max(10).default(6),
  expiresAt: isoInstant.nullish().transform((v) => v ?? null),
  deliveryTerms: optText(300),
  paymentTerms: optText(200),
};

export const buyerMandateSchema = z.object({
  optIn: z.literal(true, { error: "Confirm that you want an agent to act for you." }),
  ...base,
  title: z.string().trim().min(5, "Give the requirement a short title (5+ characters)").max(140),
  requirement: z.string().trim().min(10, "Describe what you need (10+ characters)").max(4000),
  deliveryCity: optText(80),
  deliveryPincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a 6-digit pincode").nullish().transform((v) => v ?? null),
  quantity: z.number().int().positive().max(2_000_000_000),
  unit: z.string().trim().min(1).max(20),
  targetPricePaise: paise.nullish().transform((v) => v ?? null),
  maxPricePaise: paise,
  maxLeadTimeDays: z.number().int().min(1).max(365).nullish().transform((v) => v ?? null),
  approvedSellerIds: z.array(z.string().uuid()).max(50).default([]),
  recurrenceDays: z.number().int().min(1).max(365).nullish().transform((v) => v ?? null),
  startAt: isoInstant.nullish().transform((v) => v ?? null),
  autoAccept: z.boolean().default(false),
  autoAcceptConsent: z.boolean().default(false),
  autoAcceptLimitPaise: paise.nullish().transform((v) => v ?? null),
});
export type BuyerMandateInput = z.input<typeof buyerMandateSchema>;

export const sellerMandateSchema = z.object({
  optIn: z.literal(true, { error: "Confirm that you want an agent to act for you." }),
  ...base,
  priceBookId: z.string().uuid().nullish().transform((v) => v ?? null),
  floorPricePaise: paise.nullish().transform((v) => v ?? null),
  maxDiscountPct: z.number().int().min(0).max(90).nullish().transform((v) => v ?? null),
  capacityQty: z.number().int().positive().max(2_000_000_000).nullish().transform((v) => v ?? null),
  autoAccept: z.boolean().default(false),
  autoAcceptConsent: z.boolean().default(false),
  autoAcceptLimitPaise: paise.nullish().transform((v) => v ?? null),
});
export type SellerMandateInput = z.input<typeof sellerMandateSchema>;

export interface MandateView {
  id: string;
  businessId: string;
  side: Side;
  status: AgentMandate["status"];
  name: string;
  categorySlug: string | null;
  title: string | null;
  requirement: string | null;
  deliveryCity: string | null;
  deliveryPincode: string | null;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  quantity: number | null;
  unit: string | null;
  targetPricePaise: number | null;
  /** buyer: maximum unit price. seller: private floor unit price (never shown to anyone else) */
  limitPricePaise: number | null;
  maxLeadTimeDays: number | null;
  maxDiscountPct: number | null;
  capacityQty: number | null;
  priceBookId: string | null;
  approvedSellerIds: string[];
  maxRounds: number;
  recurrenceDays: number | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  expiresAt: string | null;
  autoAccept: boolean;
  /** buyer: auto-accept ceiling. seller: auto-accept minimum price */
  autoAcceptLimitPaise: number | null;
  consentedAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const toMandateView = (m: AgentMandate): MandateView => {
  const spec = (m.spec ?? {}) as Record<string, string | null>;
  return {
    id: m.id, businessId: m.businessId, side: m.side, status: m.status, name: m.name, categorySlug: m.categorySlug,
    title: spec.title ?? null, requirement: spec.requirement ?? null, deliveryCity: spec.deliveryCity ?? null, deliveryPincode: spec.deliveryPincode ?? null,
    deliveryTerms: spec.deliveryTerms ?? null, paymentTerms: spec.paymentTerms ?? null, quantity: m.quantity, unit: m.unit,
    targetPricePaise: num(m.targetPricePaise), limitPricePaise: num(m.limitPricePaise), maxLeadTimeDays: m.maxLeadTimeDays, maxDiscountPct: m.maxDiscountPct,
    capacityQty: m.capacityQty, priceBookId: m.priceBookId, approvedSellerIds: (m.approvedSellerIds ?? []) as string[], maxRounds: m.maxRounds,
    recurrenceDays: m.recurrenceDays, nextRunAt: m.nextRunAt?.toISOString() ?? null, lastRunAt: m.lastRunAt?.toISOString() ?? null, expiresAt: m.expiresAt?.toISOString() ?? null,
    autoAccept: m.autoAccept, autoAcceptLimitPaise: num(m.autoAcceptLimitPaise), consentedAt: m.consentedAt.toISOString(), version: m.version,
    createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
  };
};

const validation = (message: string, details?: unknown) => new DomainError("validation", message, details);

/** Cross-field rules shared by create and update (pure). Returns the first problem or null. */
export function mandateProblem(side: Side, m: { targetPricePaise: number | null; limitPricePaise: number | null; autoAccept: boolean; autoAcceptLimitPaise: number | null; expiresAt: Date | null; maxDiscountPct?: number | null; capacityQty?: number | null }, now = new Date()): string | null {
  if (side === "buyer") {
    if (m.limitPricePaise == null) return "Set the maximum price your agent may agree to.";
    if (m.targetPricePaise != null && m.targetPricePaise > m.limitPricePaise) return "Target price cannot be above your maximum price.";
    if (m.autoAccept) {
      if (m.autoAcceptLimitPaise == null) return "Set the auto-accept ceiling.";
      if (m.autoAcceptLimitPaise > m.limitPricePaise) return "The auto-accept ceiling cannot be above your maximum price.";
    }
  } else {
    if (m.autoAccept) {
      if (m.autoAcceptLimitPaise == null) return "Set the lowest price your agent may accept on its own.";
      if (m.limitPricePaise != null && m.autoAcceptLimitPaise < m.limitPricePaise) return "The auto-accept minimum cannot be below your floor price.";
    }
  }
  if (m.expiresAt && m.expiresAt.getTime() <= now.getTime()) return "The expiry must be in the future.";
  return null;
}

async function record(db: DbClient, m: AgentMandate, action: string, actorKind: "human" | "system" | "admin" | "api", actorPersonId: string | null): Promise<void> {
  await db.agentMandateChange.create({ data: { mandateId: m.id, businessId: m.businessId, version: m.version, action, actorKind, actorPersonId, snapshot: json(toMandateView(m)) } });
}
const kindOf = (via?: Via): "human" | "system" | "admin" | "api" => (via?.kind === "external_agent" ? "api" : via?.kind === "admin" ? "admin" : via?.kind === "system" || via?.kind === "internal_agent" ? "system" : "human");

export async function createBuyerMandate(actor: Actor, input: BuyerMandateInput, via?: Via): Promise<MandateView> {
  const p = buyerMandateSchema.safeParse(input);
  if (!p.success) throw validation(p.error.issues[0]?.message ?? "Invalid mandate", p.error.issues);
  const d = p.data;
  if (d.categorySlug) {
    const { getCategoryBySlug } = await import("@cnote/catalogue");
    const c = await getCategoryBySlug(d.categorySlug);
    if (!c || c.prohibited) throw validation("Unknown or not allowed category.");
  }
  if (d.autoAccept && !d.autoAcceptConsent) throw validation("Confirm that your agent may accept deals on its own within the ceiling.");
  const expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
  const problem = mandateProblem("buyer", { targetPricePaise: d.targetPricePaise, limitPricePaise: d.maxPricePaise, autoAccept: d.autoAccept, autoAcceptLimitPaise: d.autoAcceptLimitPaise, expiresAt });
  if (problem) throw validation(problem);
  const now = new Date();
  const startAt = d.startAt ? new Date(d.startAt) : now;
  const row = await prisma.$transaction(async (tx) => {
    const m = await tx.agentMandate.create({
      data: {
        businessId: actor.businessId, side: "buyer", name: d.name, createdByPersonId: actor.personId, categorySlug: d.categorySlug,
        spec: json({ title: d.title, requirement: d.requirement, deliveryCity: d.deliveryCity, deliveryPincode: d.deliveryPincode, deliveryTerms: d.deliveryTerms, paymentTerms: d.paymentTerms }),
        quantity: d.quantity, unit: d.unit, targetPricePaise: big(d.targetPricePaise), limitPricePaise: BigInt(d.maxPricePaise), maxLeadTimeDays: d.maxLeadTimeDays,
        approvedSellerIds: json([...new Set(d.approvedSellerIds)]), maxRounds: d.maxRounds, recurrenceDays: d.recurrenceDays, nextRunAt: startAt, expiresAt,
        autoAccept: d.autoAccept, autoAcceptLimitPaise: d.autoAccept ? big(d.autoAcceptLimitPaise) : null, consentedAt: now, autoAcceptConsentAt: d.autoAccept ? now : null,
      },
    });
    await record(tx, m, "created", kindOf(via), actor.personId);
    await createdEvent(tx, m);
    await logActivity({ principalBusinessId: actor.businessId, principalSide: "buyer", action: "mandate_created", mandateId: m.id, summary: `You created the buying mandate "${m.name}"${m.autoAccept ? " with auto-accept on" : " (deals always wait for your confirmation)"}.`, actorPersonId: actor.personId }, tx);
    return m;
  });
  return toMandateView(row);
}

export async function createSellerMandate(actor: Actor, input: SellerMandateInput, via?: Via): Promise<MandateView> {
  const p = sellerMandateSchema.safeParse(input);
  if (!p.success) throw validation(p.error.issues[0]?.message ?? "Invalid mandate", p.error.issues);
  const d = p.data;
  if (d.autoAccept && !d.autoAcceptConsent) throw validation("Confirm that your agent may accept deals on its own above the minimum.");
  const expiresAt = d.expiresAt ? new Date(d.expiresAt) : null;
  const problem = mandateProblem("seller", { targetPricePaise: null, limitPricePaise: d.floorPricePaise, autoAccept: d.autoAccept, autoAcceptLimitPaise: d.autoAcceptLimitPaise, expiresAt });
  if (problem) throw validation(problem);
  if (d.priceBookId) {
    const e = await negotiation.getPriceBookEntry(actor.businessId, d.priceBookId);
    if (!e) throw validation("That price book entry was not found.");
  } else if (!(await negotiation.listPriceBook(actor.businessId)).some((e) => e.active)) {
    throw validation("Add a price book entry first: your agent quotes from your price book.");
  }
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const m = await tx.agentMandate.create({
      data: {
        businessId: actor.businessId, side: "seller", name: d.name, createdByPersonId: actor.personId, categorySlug: d.categorySlug,
        spec: json({ deliveryTerms: d.deliveryTerms, paymentTerms: d.paymentTerms }), limitPricePaise: big(d.floorPricePaise), maxDiscountPct: d.maxDiscountPct,
        capacityQty: d.capacityQty, priceBookId: d.priceBookId, maxRounds: d.maxRounds, expiresAt, autoAccept: d.autoAccept,
        autoAcceptLimitPaise: d.autoAccept ? big(d.autoAcceptLimitPaise) : null, consentedAt: now, autoAcceptConsentAt: d.autoAccept ? now : null,
      },
    });
    await record(tx, m, "created", kindOf(via), actor.personId);
    await createdEvent(tx, m);
    await logActivity({ principalBusinessId: actor.businessId, principalSide: "seller", action: "mandate_created", mandateId: m.id, summary: `You created the quoting mandate "${m.name}"${m.autoAccept ? " with auto-accept on" : " (deals always wait for your confirmation)"}.`, actorPersonId: actor.personId }, tx);
    return m;
  });
  return toMandateView(row);
}

async function createdEvent(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], m: AgentMandate) {
  const { emit } = await import("@cnote/core");
  await emit(tx, "AgentMandateCreated", { type: "agent_mandate", id: m.id }, { mandateId: m.id, businessId: m.businessId, side: m.side, autoAccept: m.autoAccept });
}

async function own(actor: Actor, id: string): Promise<AgentMandate> {
  const m = isUuid(id) ? await prisma.agentMandate.findFirst({ where: { id, businessId: actor.businessId } }) : null;
  if (!m) throw new DomainError("not_found", "Mandate not found");
  return m;
}

export async function listMandates(businessId: string, opts: { side?: Side; status?: AgentMandate["status"] } = {}): Promise<MandateView[]> {
  const rows = await prisma.agentMandate.findMany({ where: { businessId, ...(opts.side ? { side: opts.side } : {}), ...(opts.status ? { status: opts.status } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map(toMandateView);
}
export async function getMandate(businessId: string, id: string): Promise<MandateView | null> {
  if (!isUuid(id)) return null;
  const m = await prisma.agentMandate.findFirst({ where: { id, businessId } });
  return m ? toMandateView(m) : null;
}

export interface MandateChangeView { id: string; version: number; action: string; actorKind: string; byPerson: boolean; snapshot: MandateView; createdAt: string }
/** Every change to a mandate, newest first (the audit trail shown to its owner). */
export async function listMandateChanges(businessId: string, mandateId: string): Promise<MandateChangeView[]> {
  if (!isUuid(mandateId)) return [];
  const rows = await prisma.agentMandateChange.findMany({ where: { businessId, mandateId }, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map((r) => ({ id: r.id, version: r.version, action: r.action, actorKind: r.actorKind, byPerson: r.actorPersonId !== null, snapshot: r.snapshot as unknown as MandateView, createdAt: r.createdAt.toISOString() }));
}

export const mandatePatchSchema = z.object({
  name: base.name.optional(),
  title: z.string().trim().min(5).max(140).optional(),
  requirement: z.string().trim().min(10).max(4000).optional(),
  deliveryCity: optText(80).optional(),
  deliveryPincode: z.string().trim().regex(/^[1-9]\d{5}$/, "Enter a 6-digit pincode").nullish().transform((v) => v ?? null).optional(),
  deliveryTerms: optText(300).optional(),
  paymentTerms: optText(200).optional(),
  categorySlug: optText(100).optional(),
  quantity: z.number().int().positive().max(2_000_000_000).optional(),
  unit: z.string().trim().min(1).max(20).optional(),
  targetPricePaise: paise.nullish().transform((v) => v ?? null).optional(),
  /** buyer maximum price / seller floor price */
  limitPricePaise: paise.nullish().transform((v) => v ?? null).optional(),
  maxLeadTimeDays: z.number().int().min(1).max(365).nullish().transform((v) => v ?? null).optional(),
  maxDiscountPct: z.number().int().min(0).max(90).nullish().transform((v) => v ?? null).optional(),
  capacityQty: z.number().int().positive().max(2_000_000_000).nullish().transform((v) => v ?? null).optional(),
  priceBookId: z.string().uuid().nullish().transform((v) => v ?? null).optional(),
  approvedSellerIds: z.array(z.string().uuid()).max(50).optional(),
  maxRounds: z.number().int().min(2).max(10).optional(),
  recurrenceDays: z.number().int().min(1).max(365).nullish().transform((v) => v ?? null).optional(),
  expiresAt: isoInstant.nullish().transform((v) => v ?? null).optional(),
}).strict();
export type MandatePatch = z.input<typeof mandatePatchSchema>;

/** Edit a live mandate. Open negotiations keep the bounds they started with (a snapshot); the change applies to new ones. */
export async function updateMandate(actor: Actor, id: string, patch: MandatePatch, via?: Via): Promise<MandateView> {
  const p = mandatePatchSchema.safeParse(patch);
  if (!p.success) throw validation(p.error.issues[0]?.message ?? "Invalid change", p.error.issues);
  const d = p.data;
  const m = await own(actor, id);
  if (!["active", "paused"].includes(m.status)) throw new DomainError("conflict", `A ${m.status} mandate cannot be edited.`);
  const spec = { ...((m.spec ?? {}) as Record<string, unknown>) };
  for (const k of ["title", "requirement", "deliveryCity", "deliveryPincode", "deliveryTerms", "paymentTerms"] as const) if (d[k] !== undefined) spec[k] = d[k];
  const limit = d.limitPricePaise !== undefined ? d.limitPricePaise : num(m.limitPricePaise);
  const target = d.targetPricePaise !== undefined ? d.targetPricePaise : num(m.targetPricePaise);
  const expiresAt = d.expiresAt !== undefined ? (d.expiresAt ? new Date(d.expiresAt) : null) : m.expiresAt;
  const changedExpiry = d.expiresAt !== undefined;
  const problem = mandateProblem(m.side, { targetPricePaise: target, limitPricePaise: limit, autoAccept: m.autoAccept, autoAcceptLimitPaise: num(m.autoAcceptLimitPaise), expiresAt: changedExpiry ? expiresAt : null });
  if (problem) throw validation(problem);
  if (m.side === "seller" && d.priceBookId) {
    if (!(await negotiation.getPriceBookEntry(actor.businessId, d.priceBookId))) throw validation("That price book entry was not found.");
  }
  if (m.side === "buyer" && (d.maxDiscountPct !== undefined || d.capacityQty !== undefined || d.priceBookId !== undefined)) throw validation("Those settings apply to seller mandates only.");
  if (m.side === "seller" && (d.quantity !== undefined || d.title !== undefined || d.requirement !== undefined || d.approvedSellerIds !== undefined || d.recurrenceDays !== undefined || d.maxLeadTimeDays !== undefined || d.targetPricePaise !== undefined)) throw validation("Those settings apply to buyer mandates only.");
  const nextRunAt = m.side === "buyer" && d.recurrenceDays !== undefined && m.status === "active" && !m.nextRunAt && d.recurrenceDays ? new Date(Date.now() + d.recurrenceDays * 86_400_000) : m.nextRunAt;
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.agentMandate.update({
      where: { id: m.id },
      data: {
        version: { increment: 1 }, spec: json(spec), nextRunAt,
        ...(d.name !== undefined ? { name: d.name } : {}), ...(d.categorySlug !== undefined ? { categorySlug: d.categorySlug } : {}),
        ...(d.quantity !== undefined ? { quantity: d.quantity } : {}), ...(d.unit !== undefined ? { unit: d.unit } : {}),
        ...(d.targetPricePaise !== undefined ? { targetPricePaise: big(d.targetPricePaise) } : {}), ...(d.limitPricePaise !== undefined ? { limitPricePaise: big(d.limitPricePaise) } : {}),
        ...(d.maxLeadTimeDays !== undefined ? { maxLeadTimeDays: d.maxLeadTimeDays } : {}), ...(d.maxDiscountPct !== undefined ? { maxDiscountPct: d.maxDiscountPct } : {}),
        ...(d.capacityQty !== undefined ? { capacityQty: d.capacityQty } : {}), ...(d.priceBookId !== undefined ? { priceBookId: d.priceBookId } : {}),
        ...(d.approvedSellerIds !== undefined ? { approvedSellerIds: json([...new Set(d.approvedSellerIds)]) } : {}), ...(d.maxRounds !== undefined ? { maxRounds: d.maxRounds } : {}),
        ...(d.recurrenceDays !== undefined ? { recurrenceDays: d.recurrenceDays } : {}), ...(changedExpiry ? { expiresAt } : {}),
      },
    });
    await record(tx, u, "updated", kindOf(via), actor.personId);
    await logActivity({ principalBusinessId: actor.businessId, principalSide: m.side, action: "mandate_updated", mandateId: m.id, summary: `You changed the mandate "${u.name}" (now version ${u.version}). Negotiations already running keep their earlier limits.`, actorPersonId: actor.personId }, tx);
    return u;
  });
  return toMandateView(row);
}

/** Turns auto-accept on (needs consent and a limit) or off. Off is always allowed and immediate. */
export async function setAutoAccept(actor: Actor, id: string, input: { enabled: boolean; limitPricePaise?: number | null; consent?: boolean }, via?: Via): Promise<MandateView> {
  const m = await own(actor, id);
  if (!["active", "paused"].includes(m.status)) throw new DomainError("conflict", `A ${m.status} mandate cannot be edited.`);
  let limit = num(m.autoAcceptLimitPaise);
  if (input.enabled) {
    if (input.consent !== true) throw validation("Confirm that your agent may accept deals on its own within the limit.");
    limit = input.limitPricePaise ?? limit;
    const problem = mandateProblem(m.side, { targetPricePaise: num(m.targetPricePaise), limitPricePaise: num(m.limitPricePaise), autoAccept: true, autoAcceptLimitPaise: limit, expiresAt: null });
    if (problem) throw validation(problem);
  }
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.agentMandate.update({
      where: { id: m.id },
      data: { version: { increment: 1 }, autoAccept: input.enabled, autoAcceptLimitPaise: input.enabled ? big(limit) : null, autoAcceptConsentAt: input.enabled ? new Date() : m.autoAcceptConsentAt },
    });
    await record(tx, u, input.enabled ? "auto_accept_on" : "auto_accept_off", kindOf(via), actor.personId);
    await logActivity({ principalBusinessId: actor.businessId, principalSide: m.side, action: input.enabled ? "auto_accept_on" : "auto_accept_off", mandateId: m.id, summary: input.enabled ? `You let the agent accept deals on its own for "${u.name}" within the limit you set.` : `You turned auto-accept off for "${u.name}". Every deal now waits for you.`, actorPersonId: actor.personId }, tx);
    return u;
  });
  return toMandateView(row);
}

async function setStatus(actor: Actor, id: string, to: "paused" | "active" | "revoked", via?: Via): Promise<MandateView> {
  const m = await own(actor, id);
  const from = m.status;
  if (from === to) return toMandateView(m);
  const allowed: Record<string, string[]> = { paused: ["active"], active: ["paused"], revoked: ["active", "paused", "suspended", "expired", "completed"] };
  if (!allowed[to]!.includes(from)) throw new DomainError("conflict", `A ${from} mandate cannot be ${to === "active" ? "resumed" : to}.`);
  if (to === "active" && m.expiresAt && m.expiresAt.getTime() <= Date.now()) throw new DomainError("conflict", "This mandate has expired. Create a new one.");
  const now = new Date();
  const row = await prisma.$transaction(async (tx) => {
    const u = await tx.agentMandate.update({ where: { id: m.id }, data: { status: to, version: { increment: 1 }, ...(to === "revoked" ? { revokedAt: now, nextRunAt: null, autoAccept: false } : {}) } });
    const action = to === "active" ? "resumed" : to;
    await record(tx, u, action, kindOf(via), actor.personId);
    await logActivity({ principalBusinessId: actor.businessId, principalSide: m.side, action: `mandate_${action}` as "mandate_paused", mandateId: m.id, summary: `You ${action === "resumed" ? "resumed" : action} the mandate "${u.name}".`, actorPersonId: actor.personId }, tx);
    return u;
  });
  if (to !== "active") await withdrawOpenNegotiations({ mandateId: m.id }, to === "revoked" ? "The mandate was revoked." : "The mandate was paused.", { personId: actor.personId, via });
  return toMandateView(row);
}
export const pauseMandate = (a: Actor, id: string, via?: Via) => setStatus(a, id, "paused", via);
export const resumeMandate = (a: Actor, id: string, via?: Via) => setStatus(a, id, "active", via);
export const revokeMandate = (a: Actor, id: string, via?: Via) => setStatus(a, id, "revoked", via);

/** Job: mandates past their expiry become `expired` (their open negotiations are withdrawn). Returns how many. */
export async function expireMandates(now = new Date()): Promise<number> {
  const due = await prisma.agentMandate.findMany({ where: { status: { in: ["active", "paused"] }, expiresAt: { lte: now } }, take: 200 });
  let n = 0;
  for (const m of due) {
    const done = await prisma.$transaction(async (tx) => {
      const { count } = await tx.agentMandate.updateMany({ where: { id: m.id, status: { in: ["active", "paused"] } }, data: { status: "expired", nextRunAt: null, autoAccept: false, version: { increment: 1 } } });
      if (count === 0) return false;
      const u = await tx.agentMandate.findUniqueOrThrow({ where: { id: m.id } });
      await record(tx, u, "expired", "system", null);
      await logActivity({ principalBusinessId: m.businessId, principalSide: m.side, action: "mandate_expired", mandateId: m.id, summary: `The mandate "${m.name}" expired.` }, tx);
      return true;
    });
    if (done) {
      n++;
      await withdrawOpenNegotiations({ mandateId: m.id }, "The mandate expired.", { personId: null });
    }
  }
  return n;
}
