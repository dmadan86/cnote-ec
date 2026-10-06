import { Client } from "@opensearch-project/opensearch";
import { ALIAS as DEFAULT_ALIAS, buildIndexBody, indexName, knnScoreToCosine, loadSynonyms, parseIndexVersion, toSourceDoc, type MappingOptions } from "./mapping";
import { buildKnnRequest, buildLexicalRequest, buildSuggestRequest, decodeCursor, encodeCursor, PRICE_RANGES } from "./query";
import type { FacetBucket, IndexDoc, IndexHealth, RawHit, ReindexResult, SearchFacets, SearchIndex, SearchIndexQuery, SearchIndexResult } from "./types";

/** The slice of the OpenSearch client we use (keeps the adapter mockable without a cluster). */
export interface OsClient {
  search(p: { index: string; body: unknown }): Promise<{ body: any }>;
  bulk(p: { body: unknown[]; refresh?: boolean | "wait_for" }): Promise<{ body: any }>;
  cat: { plugins(p: { format: "json" }): Promise<{ body: any }> };
  cluster: { health(p?: object): Promise<{ body: any }> };
  indices: {
    create(p: { index: string; body: unknown }): Promise<{ body: any }>;
    exists(p: { index: string }): Promise<{ body: any }>;
    getAlias(p: { name: string }): Promise<{ body: any }>;
    updateAliases(p: { body: unknown }): Promise<{ body: any }>;
    delete(p: { index: string }): Promise<{ body: any }>;
    refresh(p: { index: string }): Promise<{ body: any }>;
  };
}

export function createOpenSearchClient(env: NodeJS.ProcessEnv = process.env): Client {
  const node = env.OPENSEARCH_URL;
  if (!node) throw new Error("OPENSEARCH_URL is required when SEARCH_BACKEND=opensearch");
  const user = env.OPENSEARCH_USERNAME;
  return new Client({
    node,
    ...(user ? { auth: { username: user, password: env.OPENSEARCH_PASSWORD ?? "" } } : {}),
    ssl: { rejectUnauthorized: env.OPENSEARCH_INSECURE_TLS !== "true" },
    requestTimeout: 5_000,
    maxRetries: 2,
  });
}

const CONFLICT = 409;

export class OpenSearchIndex implements SearchIndex {
  readonly backend = "opensearch" as const;
  private icu: boolean | undefined;

  constructor(
    private readonly client: OsClient,
    private readonly opts: {
      synonyms?: string[];
      /** Staff-curated synonym lines (Solr format), read each time an index is built; failures fall back to the file set only. */
      extraSynonyms?: () => Promise<string[]>;
      synonymsPackagePath?: string;
      shards?: number;
      replicas?: number;
      /** Alias to read/write. Default `listings`; the relevance harness uses a private alias so it never touches live data. */
      alias?: string;
    } = {},
  ) {
    this.alias = opts.alias ?? DEFAULT_ALIAS;
  }
  private readonly alias: string;

  private async detectIcu(): Promise<boolean> {
    if (this.icu !== undefined) return this.icu;
    try {
      const { body } = await this.client.cat.plugins({ format: "json" });
      this.icu = Array.isArray(body) && body.some((p: { component?: string }) => p.component === "analysis-icu");
    } catch {
      this.icu = false;
    }
    return this.icu;
  }

  private async mappingOptions(): Promise<MappingOptions> {
    const curated = this.opts.synonyms ? [] : await (this.opts.extraSynonyms?.() ?? Promise.resolve([])).catch(() => [] as string[]);
    return { icu: await this.detectIcu(), synonyms: this.opts.synonyms ?? [...loadSynonyms(), ...curated], synonymsPackagePath: this.opts.synonymsPackagePath, shards: this.opts.shards, replicas: this.opts.replicas };
  }

  /** Creates listings_v1 + alias on first use. Idempotent. Returns the current concrete index. */
  async ensureIndex(): Promise<string> {
    const current = await this.currentIndices();
    if (current.length) return current.sort((a, b) => parseIndexVersion(b, this.alias) - parseIndexVersion(a, this.alias))[0]!;
    const name = indexName(1, this.alias);
    try {
      await this.client.indices.create({ index: name, body: { ...buildIndexBody(await this.mappingOptions()), aliases: { [this.alias]: {} } } });
    } catch (e) {
      if (!/resource_already_exists/.test(String((e as Error).message))) throw e; // concurrent creator won
    }
    return name;
  }

  private async currentIndices(): Promise<string[]> {
    try {
      const { body } = await this.client.indices.getAlias({ name: this.alias });
      return Object.keys(body ?? {});
    } catch (e) {
      if ((e as { statusCode?: number }).statusCode === 404) return [];
      throw e;
    }
  }

  async search(q: SearchIndexQuery): Promise<SearchIndexResult> {
    const lexReq = q.text.trim() ? buildLexicalRequest(q, { facets: decodeCursor(q.cursor) === 0 }) : null;
    const knnReq = buildKnnRequest(q);
    const [lex, vec] = await Promise.all([
      lexReq ? this.client.search({ index: this.alias, body: lexReq }) : null,
      knnReq ? this.client.search({ index: this.alias, body: knnReq }) : null,
    ]);
    const merged = new Map<string, RawHit>();
    const lexHits: any[] = lex?.body?.hits?.hits ?? [];
    const vecHits: any[] = vec?.body?.hits?.hits ?? [];
    for (const h of lexHits) merged.set(h._source.listingId, { listingId: h._source.listingId, sellerBusinessId: h._source.sellerBusinessId, lexicalScore: Number(h._score) || 0, vectorScore: 0 });
    for (const h of vecHits) {
      const prev = merged.get(h._source.listingId);
      const vectorScore = knnScoreToCosine(Number(h._score) || 0);
      if (prev) prev.vectorScore = vectorScore;
      else merged.set(h._source.listingId, { listingId: h._source.listingId, sellerBusinessId: h._source.sellerBusinessId, lexicalScore: 0, vectorScore });
    }
    const more = lexHits.length >= q.limit || vecHits.length >= q.limit;
    return {
      hits: [...merged.values()],
      nextCursor: more ? encodeCursor(decodeCursor(q.cursor) + q.limit) : null,
      facets: lex?.body?.aggregations ? parseFacets(lex.body.aggregations) : undefined,
    };
  }

  async suggest(prefix: string, limit = 8): Promise<string[]> {
    const { body } = await this.client.search({ index: this.alias, body: buildSuggestRequest(prefix, limit * 3) });
    const titles = (body?.hits?.hits ?? []).map((h: any) => String(h._source.title));
    return [...new Set<string>(titles)].slice(0, limit);
  }

  async upsert(docs: IndexDoc[]): Promise<void> {
    if (!docs.length) return;
    await this.ensureIndex();
    const res = await bulkIndex(this.client, this.alias, docs);
    if (res.failed) throw new Error(`opensearch upsert: ${res.failed} of ${docs.length} failed`);
  }

  async remove(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const version = Date.now();
    const body = ids.flatMap((id) => [{ delete: { _index: this.alias, _id: id, version, version_type: "external_gte" } }]);
    const { body: r } = await this.client.bulk({ body });
    const bad = (r?.items ?? []).filter((i: any) => i.delete?.status >= 400 && i.delete.status !== 404 && i.delete.status !== CONFLICT);
    if (bad.length) throw new Error(`opensearch remove: ${bad.length} failed`);
  }

  async health(): Promise<IndexHealth> {
    try {
      const { body } = await this.client.cluster.health();
      const status = String(body?.status);
      return { ok: status === "green" || status === "yellow", backend: "opensearch", detail: `cluster ${status}` };
    } catch (e) {
      return { ok: false, backend: "opensearch", detail: (e as Error).message };
    }
  }

  /** Builds listings_v<N+1>, bulk-loads it, then swaps the alias atomically (readers never see a partial index). */
  async reindexAll(stream: AsyncIterable<IndexDoc[]>): Promise<ReindexResult> {
    const old = await this.currentIndices();
    const next = indexName(Math.max(0, ...old.map((n) => parseIndexVersion(n, this.alias))) + 1, this.alias);
    await this.client.indices.create({ index: next, body: buildIndexBody({ ...(await this.mappingOptions()), replicas: 0 }) });
    let indexed = 0;
    let failed = 0;
    try {
      for await (const batch of stream) {
        if (!batch.length) continue;
        const r = await bulkIndex(this.client, next, batch);
        indexed += r.indexed;
        failed += r.failed;
      }
      await this.client.indices.refresh({ index: next });
    } catch (e) {
      await this.client.indices.delete({ index: next }).catch(() => undefined);
      throw e;
    }
    await this.client.indices.updateAliases({
      body: { actions: [...old.map((index) => ({ remove: { index, alias: this.alias } })), { add: { index: next, alias: this.alias } }] },
    });
    // Keep the immediately previous index for rollback; drop older ones.
    for (const index of old.sort((a, b) => parseIndexVersion(a, this.alias) - parseIndexVersion(b, this.alias)).slice(0, -1)) await this.client.indices.delete({ index }).catch(() => undefined);
    return { indexed, failed, index: next };
  }
}

async function bulkIndex(client: OsClient, index: string, docs: IndexDoc[]): Promise<{ indexed: number; failed: number }> {
  const now = Date.now();
  const body = docs.flatMap((d) => [{ index: { _index: index, _id: d.listingId, version: d.version ?? now, version_type: "external_gte" } }, toSourceDoc(d)]);
  const { body: r } = await client.bulk({ body });
  let failed = 0;
  let stale = 0;
  for (const item of r?.items ?? []) {
    const status = item.index?.status;
    if (status === CONFLICT) stale++; // a newer version is already indexed: idempotent success
    else if (status >= 400) failed++;
  }
  return { indexed: docs.length - failed - stale, failed };
}

/** A facet is either a plain aggregation or a filter-aggregation wrapping it under `v` (see buildAggs). */
const inner = (a: any) => (a?.v ?? a) as any;
function buckets(a: any): FacetBucket[] {
  return (inner(a)?.buckets ?? []).map((b: any) => ({ key: String(b.key), count: Number(b.doc_count) }));
}
export function parseFacets(a: any): SearchFacets {
  const ranges = new Map<string, { from: number | null; to: number | null }>(PRICE_RANGES.map((r) => [r.key, { from: "from" in r ? r.from : null, to: "to" in r ? r.to : null }]));
  return {
    category: buckets(a.category),
    city: buckets(a.city),
    state: buckets(a.state),
    verificationTier: buckets(a.verificationTier),
    variant: buckets(a.variant),
    price: (inner(a.price)?.buckets ?? []).map((b: any) => ({ key: String(b.key), fromPaise: ranges.get(b.key)?.from ?? null, toPaise: ranges.get(b.key)?.to ?? null, count: Number(b.doc_count) })),
  };
}
