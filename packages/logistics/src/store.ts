// Rate card persistence. The active row wins; none => DEFAULT_RATE_CARD. Writes make a new version (never edit in place);
// callers (apps/admin) wrap them in audited().
import { DomainError, redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { DEFAULT_RATE_CARD, rateCardSchema, type RateCard } from "./card";

const CACHE_KEY = "logistics:rate-card";
const CACHE_TTL = 60;

export interface RateCardRow {
  id: string;
  version: number;
  note: string | null;
  isActive: boolean;
  createdAt: string;
  card: RateCard;
}

/** The card in force. Cached 60s in Redis (fail-open); an invalid stored card is ignored in favour of the default. */
export async function getActiveRateCard(): Promise<RateCard> {
  try {
    const hit = await redis.get(CACHE_KEY);
    if (hit) {
      const p = rateCardSchema.safeParse(JSON.parse(hit));
      if (p.success) return p.data;
    }
  } catch {
    /* fail-open */
  }
  const row = await prisma.freightRateCard.findFirst({ where: { isActive: true }, orderBy: { version: "desc" } });
  const parsed = row ? rateCardSchema.safeParse(row.card) : null;
  const card = parsed?.success ? parsed.data : DEFAULT_RATE_CARD;
  await redis.set(CACHE_KEY, JSON.stringify(card), "EX", CACHE_TTL).catch(() => undefined);
  return card;
}

const toRow = (r: { id: string; version: number; note: string | null; isActive: boolean; createdAt: Date; card: unknown }): RateCardRow => ({
  id: r.id, version: r.version, note: r.note, isActive: r.isActive, createdAt: r.createdAt.toISOString(), card: rateCardSchema.catch(DEFAULT_RATE_CARD).parse(r.card),
});

export async function listRateCards(limit = 20): Promise<RateCardRow[]> {
  const rows = await prisma.freightRateCard.findMany({ orderBy: { version: "desc" }, take: limit });
  return rows.map(toRow);
}

/** Parses + validates JSON text from the admin form. Throws a validation DomainError listing the first problems. */
export function parseRateCardJson(text: string): RateCard {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DomainError("validation", "The rate card is not valid JSON.");
  }
  const p = rateCardSchema.safeParse(raw);
  if (!p.success) throw new DomainError("validation", `Invalid rate card: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return p.data;
}

/** Saves `card` as the next version and activates it. */
export async function saveRateCard(card: RateCard, staffId: string | null, note: string | null): Promise<RateCardRow> {
  const valid = rateCardSchema.parse(card);
  const row = await prisma.$transaction(async (tx) => {
    const last = await tx.freightRateCard.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    await tx.freightRateCard.updateMany({ where: { isActive: true }, data: { isActive: false } });
    return tx.freightRateCard.create({ data: { version: (last?.version ?? 0) + 1, card: valid, note, isActive: true, createdBy: staffId } });
  });
  await redis.del(CACHE_KEY).catch(() => undefined);
  return toRow(row);
}

/** Rollback / forward: makes an existing version the active one. */
export async function activateRateCard(version: number): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const target = await tx.freightRateCard.findUnique({ where: { version } });
    if (!target) throw new DomainError("not_found", "That rate card version does not exist.");
    await tx.freightRateCard.updateMany({ where: { isActive: true }, data: { isActive: false } });
    await tx.freightRateCard.update({ where: { version }, data: { isActive: true } });
  });
  await redis.del(CACHE_KEY).catch(() => undefined);
}

/** Back to the code default (deactivates every stored version). */
export async function resetRateCardToDefault(): Promise<void> {
  await prisma.freightRateCard.updateMany({ where: { isActive: true }, data: { isActive: false } });
  await redis.del(CACHE_KEY).catch(() => undefined);
}
