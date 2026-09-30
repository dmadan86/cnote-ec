import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { METRICS, type MetricDefinition, type MetricTarget, getDefinition, meetsTarget } from "./definitions";
import { type AggRow, buildSql, withWindow } from "./sql";
import { addDays, dateToDay, dayBounds, dayToDate, daysBetween, isMatured, istDay } from "./time";

export interface MetricRow {
  dimension: string;
  value: number;
  numerator: number | null;
  denominator: number | null;
}

/** Pure: turn an aggregate row into a stored value; null when there is nothing to report. */
export function toMetricRow(def: MetricDefinition, r: AggRow): MetricRow | null {
  const num = r.num ?? null;
  const den = r.den ?? null;
  let value: number | null;
  switch (def.kind) {
    case "count":
      value = num;
      break;
    case "median":
      value = den && den > 0 ? r.val : null;
      break;
    default:
      value = den && den > 0 && num != null ? num / den : null;
  }
  if (value == null || !Number.isFinite(value)) return null;
  return { dimension: r.dim, value, numerator: num, denominator: den };
}

/** Compute one metric for one IST day straight from domain_events (no writes). */
export async function computeMetric(def: MetricDefinition, day: string): Promise<MetricRow[]> {
  const { start, end } = dayBounds(day);
  const sql = withWindow(buildSql(def.spec), def.windowDays);
  const rows = await prisma.$queryRawUnsafe<AggRow[]>(sql, start, end);
  return rows.map((r) => toMetricRow(def, r)).filter((r): r is MetricRow => r !== null);
}

export interface ComputeResult {
  day: string;
  metrics: number;
  rows: number;
  alerts: number;
}

/**
 * Idempotently recompute every metric (or `only`) for `day`: each metric's rows for the day are
 * replaced atomically, so re-running (late events, backfill) converges to the same values.
 */
export async function computeDay(day: string, opts: { only?: string[]; now?: Date } = {}): Promise<ComputeResult> {
  const defs = opts.only ? opts.only.map((id) => getDefinition(id) ?? bad(id)) : METRICS;
  const date = dayToDate(day);
  let rows = 0;
  let alerts = 0;
  for (const def of defs) {
    const computed = await computeMetric(def, day);
    const computedAt = new Date();
    await prisma.$transaction([
      prisma.metricDaily.deleteMany({ where: { metric: def.id, day: date } }),
      prisma.metricDaily.createMany({
        data: computed.map((r) => ({ metric: def.id, day: date, dimension: r.dimension, value: r.value, numerator: r.numerator, denominator: r.denominator, computedAt })),
      }),
    ]);
    rows += computed.length;
    alerts += await evaluateAlert(def, day, computed.find((r) => r.dimension === ""), opts.now);
  }
  return { day, metrics: defs.length, rows, alerts };
}

function bad(id: string): never {
  throw new DomainError("validation", `Unknown metric "${id}"`);
}

export async function backfill(from: string, to: string, opts: { only?: string[] } = {}): Promise<ComputeResult[]> {
  const out: ComputeResult[] = [];
  for (const d of daysBetween(from, to)) out.push(await computeDay(d, opts));
  return out;
}

// ---------------------------------------------------------------- alerts

export function breaches(def: MetricDefinition, row: MetricRow | undefined): boolean {
  const rule = def.alert;
  if (!rule || !row) return false;
  if ((row.denominator ?? row.numerator ?? 0) < rule.minSample) return false;
  return rule.direction === "below" ? row.value < rule.threshold : row.value > rule.threshold;
}

const fmt = (def: MetricDefinition, v: number) => (def.unit === "ratio" ? `${(v * 100).toFixed(1)}%` : def.unit === "minutes" ? `${v.toFixed(1)} min` : v.toFixed(2));

/** Raise/refresh a MetricAlert when a matured day's overall value breaches its rule. Returns 1 if raised or refreshed. */
async function evaluateAlert(def: MetricDefinition, day: string, row: MetricRow | undefined, now = new Date()): Promise<number> {
  const rule = def.alert;
  if (!rule || !row || !isMatured(day, def.windowDays, now) || !breaches(def, row)) return 0;
  const message = `${def.title} (${def.adr}) was ${fmt(def, row.value)} on ${day}, ${rule.direction === "below" ? "below" : "above"} the ${fmt(def, rule.threshold)} threshold (sample ${row.denominator ?? row.numerator}).`;
  const date = dayToDate(day);
  const existing = await prisma.metricAlert.findUnique({ where: { metric_day: { metric: def.id, day: date } } });
  if (!existing) {
    await prisma.metricAlert.create({ data: { metric: def.id, day: date, value: row.value, threshold: rule.threshold, direction: rule.direction, message } });
  } else if (!existing.resolvedAt) {
    await prisma.metricAlert.update({ where: { id: existing.id }, data: { value: row.value, threshold: rule.threshold, direction: rule.direction, message } });
  } else {
    return 0; // staff already resolved this one; do not re-open
  }
  return 1;
}

export interface AlertView {
  id: string;
  metric: string;
  title: string;
  day: string;
  value: number;
  threshold: number;
  direction: "below" | "above";
  message: string;
  resolvedAt: string | null;
  createdAt: string;
}

export async function listAlerts(opts: { open?: boolean; limit?: number } = {}): Promise<AlertView[]> {
  const rows = await prisma.metricAlert.findMany({
    where: opts.open === undefined ? {} : opts.open ? { resolvedAt: null } : { resolvedAt: { not: null } },
    orderBy: [{ day: "desc" }, { createdAt: "desc" }],
    take: Math.min(Math.max(opts.limit ?? 100, 1), 500),
  });
  return rows.map((a) => ({
    id: a.id,
    metric: a.metric,
    title: getDefinition(a.metric)?.title ?? a.metric,
    day: dateToDay(a.day),
    value: a.value,
    threshold: a.threshold,
    direction: a.direction === "above" ? "above" : "below",
    message: a.message,
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  }));
}

export async function countOpenAlerts(): Promise<number> {
  return prisma.metricAlert.count({ where: { resolvedAt: null } });
}

/** Mark an alert resolved (idempotent). `staffId` is recorded by the caller's audit entry. */
export async function resolveAlert(id: string, staffId: string): Promise<AlertView> {
  void staffId;
  const existing = await prisma.metricAlert.findUnique({ where: { id } }).catch(() => null);
  if (!existing) throw new DomainError("not_found", "Alert not found.");
  if (!existing.resolvedAt) await prisma.metricAlert.update({ where: { id }, data: { resolvedAt: new Date() } });
  const [view] = (await listAlerts({ limit: 500 })).filter((a) => a.id === id);
  return view as AlertView;
}

// ---------------------------------------------------------------- reads

export interface SeriesPoint {
  day: string;
  value: number;
  numerator: number | null;
  denominator: number | null;
}

export async function getMetricSeries(metric: string, opts: { from: string; to: string; dimension?: string }): Promise<SeriesPoint[]> {
  if (!getDefinition(metric)) bad(metric);
  const rows = await prisma.metricDaily.findMany({
    where: { metric, dimension: opts.dimension ?? "", day: { gte: dayToDate(opts.from), lte: dayToDate(opts.to) } },
    orderBy: { day: "asc" },
  });
  return rows.map((r) => ({ day: dateToDay(r.day), value: r.value, numerator: r.numerator, denominator: r.denominator }));
}

export interface DimensionRow {
  dimension: string;
  value: number;
  numerator: number | null;
  denominator: number | null;
}

/** Breakdown by dimension over a range: pooled num/den for rates and averages, mean of days otherwise. */
export async function getDimensionBreakdown(metric: string, opts: { from: string; to: string }): Promise<DimensionRow[]> {
  const def = getDefinition(metric) ?? bad(metric);
  const rows = await prisma.metricDaily.findMany({
    where: { metric, dimension: { not: "" }, day: { gte: dayToDate(opts.from), lte: dayToDate(opts.to) } },
  });
  const by = new Map<string, { num: number; den: number; sum: number; n: number }>();
  for (const r of rows) {
    const a = by.get(r.dimension) ?? { num: 0, den: 0, sum: 0, n: 0 };
    a.num += r.numerator ?? 0;
    a.den += r.denominator ?? 0;
    a.sum += r.value;
    a.n += 1;
    by.set(r.dimension, a);
  }
  return [...by.entries()]
    .map(([dimension, a]) => ({
      dimension,
      value: def.kind === "rate" || def.kind === "average" ? (a.den > 0 ? a.num / a.den : 0) : a.sum / a.n,
      numerator: def.kind === "median" ? null : a.num,
      denominator: a.den > 0 ? a.den : null,
    }))
    .sort((x, y) => (y.denominator ?? 0) - (x.denominator ?? 0));
}

export type ScoreStatus = "met" | "missed" | "no_data" | "info";

export interface ScorecardRow {
  id: string;
  title: string;
  adr: string;
  unit: MetricDefinition["unit"];
  gate: boolean;
  target: MetricTarget | null;
  windowDays: number;
  /** most recent matured day with data (overall dimension) */
  latest: { day: string; value: number; denominator: number | null } | null;
  avg7: number | null;
  avg28: number | null;
  status: ScoreStatus;
  series: { day: string; value: number }[];
}

function pooled(def: MetricDefinition, rows: { value: number; numerator: number | null; denominator: number | null }[]): number | null {
  if (rows.length === 0) return null;
  if (def.kind === "rate" || def.kind === "average") {
    const den = rows.reduce((s, r) => s + (r.denominator ?? 0), 0);
    return den > 0 ? rows.reduce((s, r) => s + (r.numerator ?? 0), 0) / den : null;
  }
  return rows.reduce((s, r) => s + r.value, 0) / rows.length;
}

/** Scorecard as of `day` (default today IST): latest matured value vs target, 7/28-day pooled values, 28-day series. */
export async function getScorecard(day: string = istDay(), now: Date = new Date()): Promise<ScorecardRow[]> {
  const from = addDays(day, -27 - 90);
  const all = await prisma.metricDaily.findMany({
    where: { dimension: "", day: { gte: dayToDate(from), lte: dayToDate(day) } },
    orderBy: { day: "asc" },
  });
  return METRICS.map((def) => {
    const rows = all.filter((r) => r.metric === def.id).map((r) => ({ day: dateToDay(r.day), value: r.value, numerator: r.numerator, denominator: r.denominator }));
    const matured = rows.filter((r) => isMatured(r.day, def.windowDays, now));
    const last = matured.at(-1) ?? null;
    const anchor = last?.day ?? day;
    const win = (n: number) => matured.filter((r) => r.day > addDays(anchor, -n) && r.day <= anchor);
    const status: ScoreStatus = !last ? "no_data" : def.target ? (meetsTarget(def.target, last.value) ? "met" : "missed") : "info";
    return {
      id: def.id,
      title: def.title,
      adr: def.adr,
      unit: def.unit,
      gate: def.gate,
      target: def.target ?? null,
      windowDays: def.windowDays,
      latest: last ? { day: last.day, value: last.value, denominator: last.denominator } : null,
      avg7: pooled(def, win(7)),
      avg28: pooled(def, win(28)),
      status,
      series: win(28).map((r) => ({ day: r.day, value: r.value })),
    };
  });
}
