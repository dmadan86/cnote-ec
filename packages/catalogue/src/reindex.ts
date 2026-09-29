import * as ai from "@cnote/ai";
import { prisma, toVectorLiteral } from "@cnote/db";
import { listingInclude } from "./mappers";
import { canonicalText } from "./validate";

const BATCH = 64;

async function reindex(where: "all" | "missing" | "stale", version?: string): Promise<{ reindexed: number }> {
  let cursor = "00000000-0000-0000-0000-000000000000";
  let reindexed = 0;
  for (;;) {
    const cond =
      where === "missing" ? `AND embedding IS NULL` : where === "stale" ? `AND (embedding IS NULL OR embedding_version IS DISTINCT FROM $2)` : "";
    const ids = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM listings WHERE status = 'published' AND id > $1::uuid ${cond} ORDER BY id LIMIT ${BATCH}`,
      ...(where === "stale" ? [cursor, version] : [cursor]),
    );
    if (!ids.length) break;
    cursor = ids[ids.length - 1]!.id;
    const rows = await prisma.listing.findMany({ where: { id: { in: ids.map((r) => r.id) } }, include: listingInclude });
    const texts = rows.map((r) => canonicalText({ title: r.title, description: r.description, attributes: (r.attributes ?? {}) as Record<string, string | number> }, r.category.name));
    const { vectors, version: v } = await ai.embed(texts);
    await prisma.$transaction(
      rows.flatMap((r, i) => (vectors[i] ? [prisma.$executeRaw`UPDATE listings SET embedding = ${toVectorLiteral(vectors[i]!)}::vector, embedding_version = ${v} WHERE id = ${r.id}::uuid`] : [])),
    );
    reindexed += rows.length;
  }
  return { reindexed };
}

/** Re-embeds published listings in batches: after a model/version change, and for seeding. */
export async function reindexEmbeddings(opts: { onlyMissing?: boolean } = {}): Promise<{ reindexed: number }> {
  return reindex(opts.onlyMissing ? "missing" : "all");
}

/** Nightly: re-embed only listings whose embeddingVersion differs from the provider's current version. */
export async function reindexStaleEmbeddings(): Promise<{ reindexed: number }> {
  const { version } = await ai.embed(["version probe"]);
  return reindex("stale", version);
}
