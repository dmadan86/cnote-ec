import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { z } from "zod";
import { DomainError } from "@cnote/core";
import type { UsageDay } from "./types";

const USAGE_TTL_SECONDS = 3 * 86_400;
const TOUCH_INTERVAL_SECONDS = 60;
const usageKey = (keyId: string, day: string) => `apikey:usage:${keyId}:${day}`;
export const dayString = (d: Date = new Date()) => d.toISOString().slice(0, 10);

/** Count one request (and MCP call), and touch lastUsedAt/lastUsedIp at most once a minute per key. */
export async function bumpUsage(keyId: string, kind: "rest" | "mcp", ip: string | null): Promise<void> {
  const k = usageKey(keyId, dayString());
  const p = redis.multi().hincrby(k, "requests", 1);
  if (kind === "mcp") p.hincrby(k, "mcp", 1);
  await p.expire(k, USAGE_TTL_SECONDS).exec();
  const first = await redis.set(`apikey:touch:${keyId}`, "1", "EX", TOUCH_INTERVAL_SECONDS, "NX");
  if (first === "OK") {
    prisma.apiKey
      .update({ where: { id: keyId }, data: { lastUsedAt: new Date(), lastUsedIp: ip?.slice(0, 64) ?? null }, select: { id: true } })
      .catch(() => undefined); // best effort (key may have been deleted)
  }
}

/** Count a failed request (4xx/5xx) for a key. Called by apps/api. */
export async function recordApiError(keyId: string): Promise<void> {
  const k = usageKey(keyId, dayString());
  await redis.multi().hincrby(k, "errors", 1).expire(k, USAGE_TTL_SECONDS).exec();
}

const asInt = (v: string | undefined) => Math.max(0, Number.parseInt(v ?? "0", 10) || 0);

/**
 * Move Redis counters into ApiKeyUsageDaily. Each hash is atomically read-and-deleted (MULTI), then
 * added to the row; on a DB failure the counts are put back so nothing is lost. Returns rows flushed.
 */
export async function flushApiKeyUsage(): Promise<number> {
  let cursor = "0";
  let flushed = 0;
  const uuid = /^apikey:usage:([0-9a-f-]{36}):(\d{4}-\d{2}-\d{2})$/;
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", "apikey:usage:*", "COUNT", 200);
    cursor = next;
    for (const k of keys) {
      const m = uuid.exec(k);
      if (!m) continue;
      const [, keyId, day] = m as unknown as [string, string, string];
      const res = await redis.multi().hgetall(k).del(k).exec();
      const h = (res?.[0]?.[1] ?? {}) as Record<string, string>;
      const inc = { requests: asInt(h.requests), errors: asInt(h.errors), mcpCalls: asInt(h.mcp) };
      if (inc.requests + inc.errors + inc.mcpCalls === 0) continue;
      try {
        await prisma.apiKeyUsageDaily.upsert({
          where: { apiKeyId_day: { apiKeyId: keyId, day: new Date(`${day}T00:00:00.000Z`) } },
          create: { apiKeyId: keyId, day: new Date(`${day}T00:00:00.000Z`), ...inc },
          update: { requests: { increment: inc.requests }, errors: { increment: inc.errors }, mcpCalls: { increment: inc.mcpCalls } },
        });
        flushed++;
      } catch (err) {
        if ((err as { code?: string }).code === "P2003") continue; // key deleted: drop
        await redis.multi().hincrby(k, "requests", inc.requests).hincrby(k, "errors", inc.errors).hincrby(k, "mcp", inc.mcpCalls).expire(k, USAGE_TTL_SECONDS).exec();
        throw err;
      }
    }
  } while (cursor !== "0");
  return flushed;
}

function emptySeries(days: number, now: Date): UsageDay[] {
  const out: UsageDay[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ day: dayString(new Date(now.getTime() - i * 86_400_000)), requests: 0, errors: 0, mcpCalls: 0 });
  return out;
}

/** Daily series (oldest first, `days` entries, zero-filled) = flushed rows + not-yet-flushed Redis counters. */
export async function loadUsage(keyId: string, days: number, now = new Date()): Promise<UsageDay[]> {
  const series = emptySeries(days, now);
  const byDay = new Map(series.map((d) => [d.day, d]));
  const rows = await prisma.apiKeyUsageDaily.findMany({
    where: { apiKeyId: keyId, day: { gte: new Date(`${series[0]!.day}T00:00:00.000Z`) } },
  });
  for (const r of rows) {
    const d = byDay.get(dayString(r.day));
    if (d) { d.requests += r.requests; d.errors += r.errors; d.mcpCalls += r.mcpCalls; }
  }
  const pending = await Promise.all(series.map((d) => redis.hgetall(usageKey(keyId, d.day))));
  series.forEach((d, i) => {
    const h = pending[i] as Record<string, string>;
    d.requests += asInt(h.requests); d.errors += asInt(h.errors); d.mcpCalls += asInt(h.mcp);
  });
  return series;
}

/** Usage for one of the person's own keys. */
export async function getKeyUsage(personId: string, keyId: string, days = 30): Promise<UsageDay[]> {
  if (!z.uuid().safeParse(keyId).success) throw new DomainError("not_found", "API key not found.");
  const owned = await prisma.apiKey.findFirst({ where: { id: keyId, personId }, select: { id: true } });
  if (!owned) throw new DomainError("not_found", "API key not found.");
  return loadUsage(keyId, Math.min(Math.max(1, Math.floor(days)), 90));
}

/** True when any of the person's API keys was used since `since` (programmatic use counts as the person approaching us: DPDP inactivity erasure). */
export async function hasApiKeyActivitySince(personId: string, since: Date): Promise<boolean> {
  return (await prisma.apiKey.count({ where: { personId, lastUsedAt: { gte: since } } })) > 0;
}
