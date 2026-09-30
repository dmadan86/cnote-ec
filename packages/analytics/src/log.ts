// Read side of the append-only domain event log (ADR-007). Sanctioned exception in scripts/check-boundaries.ts (same as
// @cnote/metrics): read-only, this file only. Writes to domain_events stay in @cnote/core.
import { prisma, type Tx } from "@cnote/db";
import type { DomainEvent, DomainEventType } from "@cnote/core";

const MAX_ID = 9_223_372_036_854_775_807n;

/**
 * Highest event id a projection may safely advance to in this pass: the id of the `batch`-th event after `afterId`, counting
 * only events older than `cutoff` (the safety lag lets in-flight transactions commit, so a lower id never appears AFTER the
 * checkpoint passed it) and not beyond `cap` (a dependency projection's checkpoint). null = nothing to do.
 */
export async function scanBound(tx: Tx, afterId: bigint, batch: number, cutoff: Date, cap: bigint | null): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{ id: bigint | null }[]>`
    SELECT max(id) AS id FROM (
      SELECT id FROM domain_events WHERE id > ${afterId} AND id <= ${cap ?? MAX_ID} AND occurred_at <= ${cutoff} ORDER BY id LIMIT ${batch}
    ) t`;
  return rows[0]?.id ?? null;
}

export async function readEvents(tx: Tx, afterId: bigint, upToId: bigint, types: readonly DomainEventType[]): Promise<DomainEvent[]> {
  const rows = await tx.$queryRaw<
    { id: bigint; type: string; version: number; aggregate_type: string; aggregate_id: string; payload: unknown; occurred_at: Date }[]
  >`SELECT id, type, version, aggregate_type, aggregate_id, payload, occurred_at
    FROM domain_events WHERE id > ${afterId} AND id <= ${upToId} AND type = ANY(${types as string[]}) ORDER BY id`;
  return rows.map((r) => ({
    id: Number(r.id), type: r.type as DomainEventType, version: r.version, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
    payload: r.payload as never, occurredAt: r.occurred_at.toISOString(),
  }));
}

export async function latestEventId(): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ id: bigint | null }[]>`SELECT max(id) AS id FROM domain_events`;
  return rows[0]?.id ?? 0n;
}
