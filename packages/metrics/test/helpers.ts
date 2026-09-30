import { prisma } from "@cnote/db";

export const AGG = "MetricsTest";
let seq = 0;
export const uid = (p: string) => `${p}-${process.pid}-${++seq}`;

/** Instant on an IST day, e.g. at("2001-01-10", "10:00") or with day offset. */
export function at(day: string, hhmm = "10:00", plusMs = 0): Date {
  return new Date(new Date(`${day}T${hhmm}:00+05:30`).getTime() + plusMs);
}
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export interface Ev {
  type: string;
  payload: Record<string, unknown>;
  at: Date;
}
export const ev = (type: string, payload: Record<string, unknown>, when: Date): Ev => ({ type, payload, at: when });

export async function insert(events: Ev[], ns = AGG): Promise<void> {
  await prisma.domainEvent.createMany({
    data: events.map((e) => ({ type: e.type, aggregateType: ns, aggregateId: uid("agg"), payload: e.payload as object, occurredAt: e.at, publishedAt: e.at })),
  });
}

/** Test files run in parallel on one DB: each owns a namespace (aggregate type) and a disjoint day range. */
export async function cleanup(ns = AGG, from = "2001-01-01", to = "2001-04-30"): Promise<void> {
  const range = { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) };
  await prisma.domainEvent.deleteMany({ where: { aggregateType: ns } });
  await prisma.metricDaily.deleteMany({ where: { day: range } });
  await prisma.metricAlert.deleteMany({ where: { day: range } });
}

export async function row(metric: string, day: string, dimension = "") {
  return prisma.metricDaily.findUnique({ where: { metric_day_dimension: { metric, day: new Date(`${day}T00:00:00Z`), dimension } } });
}
