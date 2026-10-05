// Fake-lead risk (ADR-002 intent score input "device/behavioural signals") + the labelled data to measure it.
//
// Privacy by construction (DPDP, docs/design/verification-t2-t3.md):
//   * no raw IP is stored: only a keyed hash (blind index, HKDF per purpose) of the /24 (IPv4) or /48 (IPv6) prefix;
//   * no device cookie / fingerprint: nothing is written to the browser, so the cookie-consent registry is untouched.
//     The signals are server-side only: user-agent FAMILY (not the string), and velocity counts per person and per ip-prefix;
//   * rows are purged after 90 days (hash nulled; the ops label and risk score stay for precision/recall).
// The score feeds ai.scoreIntent as `fakeLeadRisk` (applied for every provider, logged in the AiDecision input).
import { DomainError, emit } from "@cnote/core";
import { prisma, type Prisma } from "@cnote/db";
import { blindIndex, neutraliseFormula } from "@cnote/security";

export const SIGNAL_RETENTION_DAYS = 90;
/** An enquiry counts as "predicted fake" when its risk score is at or above this, or its intent score is below INTENT_FAKE_BELOW. */
export const RISK_PREDICT_FAKE_AT = 60;
export const INTENT_FAKE_BELOW = 20;
export const LABELS = ["genuine", "fake", "spam", "unreachable"] as const;
export type EnquiryLabel = (typeof LABELS)[number];
/** Labels that count as a fake lead for precision/recall. */
export const FAKE_LABELS: readonly EnquiryLabel[] = ["fake", "spam", "unreachable"];

// ---------------- pure helpers ----------------
export type UaFamily = "chrome-android" | "safari-ios" | "chrome-desktop" | "safari-desktop" | "firefox" | "edge" | "samsung" | "bot" | "script" | "other" | "none";

/** Coarse user-agent family; the raw string is never stored. */
export function uaFamily(ua: string | null | undefined): UaFamily {
  const s = (ua ?? "").trim();
  if (!s) return "none";
  if (/bot|crawler|spider|headless|phantom|puppeteer|playwright|selenium/i.test(s)) return "bot";
  if (/^(curl|wget|python|node|axios|okhttp|go-http|java|libwww|httpie|postman)/i.test(s)) return "script";
  if (/SamsungBrowser/i.test(s)) return "samsung";
  if (/Edg(e|A|iOS)?\//i.test(s)) return "edge";
  if (/Firefox|FxiOS/i.test(s)) return "firefox";
  if (/iPhone|iPad/i.test(s)) return "safari-ios";
  if (/Android/i.test(s) && /Chrome|CriOS/i.test(s)) return "chrome-android";
  if (/Chrome|CriOS/i.test(s)) return "chrome-desktop";
  if (/Safari/i.test(s)) return "safari-desktop";
  return "other";
}

/** "203.0.113.45" -> "203.0.113"; IPv6 -> first 3 hextets. Null for anything else (never guesses). */
export function ipPrefix(ip: string | null | undefined): string | null {
  const s = (ip ?? "").trim();
  if (!s) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(s);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}`;
  if (s.includes(":") && /^[0-9a-f:.]+$/i.test(s) && !s.includes(".")) {
    const parts = s.split("::")[0]!.split(":");
    if (parts.length >= 3) return parts.slice(0, 3).map((p) => p.toLowerCase().padStart(4, "0")).join(":");
    const head = parts.concat(Array(3).fill("0")).slice(0, 3);
    return head.map((p) => (p || "0").toLowerCase().padStart(4, "0")).join(":");
  }
  return null;
}
export const hashIpPrefix = (ip: string | null | undefined): string | null => {
  const p = ipPrefix(ip);
  return p ? blindIndex(p, "enquiry.ip-prefix") : null;
};

export interface RiskInput {
  uaFamily: UaFamily;
  hasIp: boolean;
  phoneVerified: boolean;
  /** enquiries by this person in the last hour / 24 hours (excluding the one being created) */
  velocityPerson1h: number;
  velocityPerson24h: number;
  /** distinct buyers who posted from the same ip-prefix in the last 24 hours (excluding this person) */
  distinctOtherPersonsOnIp24h: number;
}
export interface RiskResult { score: number; reasons: string[] }

/** Pure and deterministic: weights are summed and capped at 100. Every rule that fires adds a human-readable reason. */
export function computeFakeLeadRisk(i: RiskInput): RiskResult {
  let score = 0;
  const reasons: string[] = [];
  const add = (pts: number, why: string) => { score += pts; reasons.push(why); };
  if (i.uaFamily === "bot") add(40, "Automated browser signature");
  else if (i.uaFamily === "script") add(35, "Posted by a script, not a browser");
  else if (i.uaFamily === "none") add(15, "No browser information");
  if (!i.hasIp) add(10, "No network address");
  if (i.velocityPerson1h >= 5) add(40, `${i.velocityPerson1h} enquiries from this buyer in the last hour`);
  else if (i.velocityPerson1h >= 3) add(20, `${i.velocityPerson1h} enquiries from this buyer in the last hour`);
  if (i.velocityPerson24h >= 10) add(20, `${i.velocityPerson24h} enquiries from this buyer in 24 hours`);
  else if (i.velocityPerson24h >= 6) add(10, `${i.velocityPerson24h} enquiries from this buyer in 24 hours`);
  if (i.distinctOtherPersonsOnIp24h >= 6) add(35, `${i.distinctOtherPersonsOnIp24h + 1} different buyers posted from one network in 24 hours`);
  else if (i.distinctOtherPersonsOnIp24h >= 3) add(20, `${i.distinctOtherPersonsOnIp24h + 1} different buyers posted from one network in 24 hours`);
  if (!i.phoneVerified) add(10, "Phone number not verified");
  return { score: Math.min(100, score), reasons };
}

// ---------------- collection ----------------
export interface SignalContext { ip?: string | null; userAgent?: string | null; phoneVerified?: boolean }
export interface CollectedSignals { ipHash: string | null; uaFamily: UaFamily; velocityPerson1h: number; velocityPerson24h: number; velocityIp24h: number; risk: RiskResult }

/** Reads velocity counts and derives the risk score. Never throws: a failure yields no signals (the enquiry must still go through). */
export async function collectSignals(personId: string, ctx: SignalContext, now = new Date()): Promise<CollectedSignals | null> {
  try {
    const ipHash = hashIpPrefix(ctx.ip);
    const h1 = new Date(now.getTime() - 3_600_000), h24 = new Date(now.getTime() - 86_400_000);
    const [v1, v24, ipRows] = await Promise.all([
      prisma.enquiry.count({ where: { buyerPersonId: personId, createdAt: { gte: h1 } } }),
      prisma.enquiry.count({ where: { buyerPersonId: personId, createdAt: { gte: h24 } } }),
      ipHash ? prisma.enquirySignals.findMany({ where: { ipHash, createdAt: { gte: h24 } }, select: { enquiryId: true } }) : Promise.resolve([] as { enquiryId: string }[]),
    ]);
    const others = ipRows.length
      ? new Set((await prisma.enquiry.findMany({ where: { id: { in: ipRows.map((r) => r.enquiryId) }, buyerPersonId: { not: personId } }, select: { buyerPersonId: true } })).map((e) => e.buyerPersonId)).size
      : 0;
    const family = uaFamily(ctx.userAgent);
    const risk = computeFakeLeadRisk({ uaFamily: family, hasIp: !!ipHash, phoneVerified: ctx.phoneVerified ?? false, velocityPerson1h: v1, velocityPerson24h: v24, distinctOtherPersonsOnIp24h: others });
    return { ipHash, uaFamily: family, velocityPerson1h: v1, velocityPerson24h: v24, velocityIp24h: ipRows.length, risk };
  } catch (err) {
    console.warn("[enquiry] fake-lead signals unavailable", (err as Error).message);
    return null;
  }
}

export async function recordSignals(tx: Prisma.TransactionClient, enquiryId: string, s: CollectedSignals): Promise<void> {
  await tx.enquirySignals.create({
    data: { enquiryId, ipHash: s.ipHash, uaFamily: s.uaFamily, velocityPerson1h: s.velocityPerson1h, velocityPerson24h: s.velocityPerson24h, velocityIp24h: s.velocityIp24h, riskScore: s.risk.score, riskReasons: s.risk.reasons },
  });
}

// ---------------- ops labels ----------------
/** Staff label (wrap in admin.audited("enquiries.label")). Emits EnquiryLabelled so the precision/recall metrics read the event log. */
export async function labelEnquiry(enquiryId: string, label: EnquiryLabel, staffId: string): Promise<{ label: EnquiryLabel; predictedFake: boolean }> {
  if (!(LABELS as readonly string[]).includes(label)) throw new DomainError("validation", "Unknown label.");
  const s = await prisma.enquirySignals.findUnique({ where: { enquiryId } });
  const e = await prisma.enquiry.findUnique({ where: { id: enquiryId }, select: { intentScore: true } });
  if (!e) throw new DomainError("not_found", "Enquiry not found.");
  const predictedFake = (s?.riskScore ?? 0) >= RISK_PREDICT_FAKE_AT || (e.intentScore !== null && e.intentScore < INTENT_FAKE_BELOW);
  await prisma.$transaction(async (tx) => {
    const now = new Date();
    if (s) await tx.enquirySignals.update({ where: { enquiryId }, data: { label, labelledBy: staffId, labelledAt: now } });
    else await tx.enquirySignals.create({ data: { enquiryId, uaFamily: "none", riskScore: 0, riskReasons: [], label, labelledBy: staffId, labelledAt: now } });
    await emit(tx, "EnquiryLabelled", { type: "enquiry", id: enquiryId }, {
      enquiryId, label, isFake: FAKE_LABELS.includes(label), predictedFake, riskScore: s?.riskScore ?? 0, intentScore: e.intentScore,
    });
  });
  return { label, predictedFake };
}

export interface LabelQueueItem { enquiryId: string; title: string; intentScore: number | null; riskScore: number; riskReasons: string[]; uaFamily: string; status: string; label: string | null; createdAt: string }
/** Ops queue: unlabelled enquiries, riskiest first (so labels cover the cases that matter), optionally only labelled ones. */
export async function listLabelQueue(opts: { labelled?: boolean; limit?: number } = {}): Promise<LabelQueueItem[]> {
  const rows = await prisma.enquirySignals.findMany({ where: { label: opts.labelled ? { not: null } : null }, orderBy: opts.labelled ? { labelledAt: "desc" } : [{ riskScore: "desc" }, { createdAt: "desc" }], take: Math.min(Math.max(opts.limit ?? 50, 1), 200) });
  const enq = new Map((await prisma.enquiry.findMany({ where: { id: { in: rows.map((r) => r.enquiryId) } }, select: { id: true, title: true, intentScore: true, status: true } })).map((e) => [e.id, e]));
  return rows.flatMap((r) => { const e = enq.get(r.enquiryId); return e ? [{ enquiryId: r.enquiryId, title: e.title, intentScore: e.intentScore, riskScore: r.riskScore, riskReasons: r.riskReasons, uaFamily: r.uaFamily, status: e.status, label: r.label, createdAt: r.createdAt.toISOString() }] : []; });
}

// ---------------- labelled-data export + precision/recall ----------------
export interface LabelledRow { enquiryId: string; createdAt: string; label: string; isFake: boolean; riskScore: number; intentScore: number | null; predictedFake: boolean; uaFamily: string; velocityPerson1h: number; velocityPerson24h: number; velocityIp24h: number; reachability: string }

export async function labelledRows(opts: { since?: Date; until?: Date; limit?: number } = {}): Promise<LabelledRow[]> {
  const rows = await prisma.enquirySignals.findMany({
    where: { label: { not: null }, ...(opts.since || opts.until ? { labelledAt: { ...(opts.since ? { gte: opts.since } : {}), ...(opts.until ? { lt: opts.until } : {}) } } : {}) },
    orderBy: { labelledAt: "asc" }, take: Math.min(opts.limit ?? 50_000, 100_000),
  });
  const ids = rows.map((r) => r.enquiryId);
  const [enq, checks] = await Promise.all([
    prisma.enquiry.findMany({ where: { id: { in: ids } }, select: { id: true, intentScore: true } }),
    prisma.reachabilityCheck.findMany({ where: { enquiryId: { in: ids } }, orderBy: { createdAt: "asc" }, select: { enquiryId: true, status: true } }),
  ]);
  const intent = new Map(enq.map((e) => [e.id, e.intentScore]));
  const reach = new Map<string, string>();
  for (const c of checks) reach.set(c.enquiryId, c.status); // latest wins
  return rows.map((r) => {
    const is = intent.get(r.enquiryId) ?? null;
    return {
      enquiryId: r.enquiryId, createdAt: r.createdAt.toISOString(), label: r.label!, isFake: FAKE_LABELS.includes(r.label as EnquiryLabel), riskScore: r.riskScore, intentScore: is,
      predictedFake: r.riskScore >= RISK_PREDICT_FAKE_AT || (is !== null && is < INTENT_FAKE_BELOW), uaFamily: r.uaFamily,
      velocityPerson1h: r.velocityPerson1h, velocityPerson24h: r.velocityPerson24h, velocityIp24h: r.velocityIp24h, reachability: reach.get(r.enquiryId) ?? "none",
    };
  });
}

const CSV_COLUMNS: (keyof LabelledRow)[] = ["enquiryId", "createdAt", "label", "isFake", "riskScore", "intentScore", "predictedFake", "uaFamily", "velocityPerson1h", "velocityPerson24h", "velocityIp24h", "reachability"];
const cell = (v: unknown): string => {
  const s = String(neutraliseFormula(v === null || v === undefined ? "" : v));
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** CSV for offline model work. No free text (titles, names, contacts) leaves the system; text cells are formula-injection safe. */
export function labelledRowsToCsv(rows: LabelledRow[]): string {
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
export async function exportFakeLeadLabelsCsv(opts: { since?: Date; until?: Date } = {}): Promise<string> {
  return labelledRowsToCsv(await labelledRows(opts));
}

export interface PrecisionRecall { labelled: number; truePositive: number; falsePositive: number; falseNegative: number; trueNegative: number; precision: number | null; recall: number | null }
/** Pure. Precision = TP/(TP+FP), recall = TP/(TP+FN); null when the denominator is 0 (no labels yet). */
export function precisionRecall(rows: Pick<LabelledRow, "isFake" | "predictedFake">[]): PrecisionRecall {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of rows) {
    if (r.predictedFake && r.isFake) tp++;
    else if (r.predictedFake) fp++;
    else if (r.isFake) fn++;
    else tn++;
  }
  return { labelled: rows.length, truePositive: tp, falsePositive: fp, falseNegative: fn, trueNegative: tn, precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}
export async function fakeLeadPrecisionRecall(opts: { since?: Date; until?: Date } = {}): Promise<PrecisionRecall> {
  return precisionRecall(await labelledRows(opts));
}

/** Retention: nulls the ip hash and velocity detail of signals older than `before` (label + score stay for model evaluation). */
export async function purgeEnquirySignals(before: Date, opts: { dryRun?: boolean } = {}): Promise<number> {
  const where = { createdAt: { lt: before }, ipHash: { not: null } } as const;
  if (opts.dryRun) return prisma.enquirySignals.count({ where });
  return (await prisma.enquirySignals.updateMany({ where, data: { ipHash: null } })).count;
}
