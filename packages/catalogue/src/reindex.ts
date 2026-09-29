import * as ai from "@cnote/ai";
import { liveDb, toVectorLiteral } from "@cnote/live-db";
import { canonicalText } from "./validate";

const BATCH = 64;

/** Re-embeds rows of the LIVE database in place (embeddings live only there; authoring versions store text, not vectors). */
async function reindex(where: "all" | "missing" | "stale", version?: string): Promise<{ reindexed: number }> {
  let cursor = "00000000-0000-0000-0000-000000000000";
  let reindexed = 0;
  for (;;) {
    const cond = where === "missing" ? `AND embedding IS NULL` : where === "stale" ? `AND (embedding IS NULL OR embedding_version IS DISTINCT FROM $2)` : "";
    const rows = await liveDb.$queryRawUnsafe<{ id: string; title: string; description: string; attributes: Record<string, string | number>; category_name: string }[]>(
      `SELECT id::text AS id, title, description, attributes, category_name FROM live_listings WHERE id > $1::uuid ${cond} ORDER BY id LIMIT ${BATCH}`,
      ...(where === "stale" ? [cursor, version] : [cursor]),
    );
    if (!rows.length) break;
    cursor = rows[rows.length - 1]!.id;
    const texts = rows.map((r) => canonicalText({ title: r.title, description: r.description, attributes: r.attributes ?? {} }, r.category_name));
    const { vectors, version: v } = await ai.embed(texts);
    await liveDb.$transaction(
      rows.flatMap((r, i) => (vectors[i] ? [liveDb.$executeRaw`UPDATE live_listings SET embedding = ${toVectorLiteral(vectors[i]!)}::vector, embedding_version = ${v} WHERE id = ${r.id}::uuid`] : [])),
    );
    reindexed += rows.length;
  }
  return { reindexed };
}

/** Re-embeds live listings in batches: after a model/version change, and for seeding. */
export async function reindexEmbeddings(opts: { onlyMissing?: boolean } = {}): Promise<{ reindexed: number }> {
  return reindex(opts.onlyMissing ? "missing" : "all");
}

/** Nightly: re-embed only live listings whose embeddingVersion differs from the provider's current version. */
export async function reindexStaleEmbeddings(): Promise<{ reindexed: number }> {
  const { version } = await ai.embed(["version probe"]);
  return reindex("stale", version);
}
