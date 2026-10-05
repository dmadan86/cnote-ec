// Versioned synonym dictionary storage (ADR-009). Append-only by convention: publishing and rolling back both INSERT a new
// version; nothing is updated or deleted, so the history is the audit trail of what search looked like when. The active
// dictionary is the highest version. Reads are cached in-process for a short time (search is on the hot path); a publish
// invalidates the local cache at once and other instances converge within SYNONYM_CACHE_MS.
import { readFileSync } from "node:fs";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { checkGroups, parseSolr, toSolrLines, type SynonymGroup } from "./groups";

export const SYNONYM_CACHE_MS = 30_000;
export type SynonymSource = "seed" | "edit" | "rollback" | "import";

export interface SynonymSet {
  /** 0 = nothing published yet (empty dictionary) */
  version: number;
  groups: SynonymGroup[];
}
export interface SynonymVersionSummary {
  version: number;
  groupCount: number;
  source: string;
  basedOnVersion: number | null;
  note: string | null;
  createdByStaffId: string | null;
  createdAt: Date;
}

const EMPTY: SynonymSet = { version: 0, groups: [] };
let cache: { at: number; set: SynonymSet } | undefined;

export function invalidateSynonymCache(): void {
  cache = undefined;
}

/** Groups stored as JSON are re-validated on read: a hand-edited row can never break search. */
const readGroups = (json: unknown): SynonymGroup[] => checkGroups(json).groups;

export async function getActiveSynonyms(now = Date.now()): Promise<SynonymSet> {
  if (cache && now - cache.at < SYNONYM_CACHE_MS) return cache.set;
  const row = await prisma.searchSynonymVersion.findFirst({ orderBy: { version: "desc" } });
  const set = row ? { version: row.version, groups: readGroups(row.groups) } : EMPTY;
  cache = { at: now, set };
  return set;
}

/**
 * The hot-path accessor: a failing dictionary read (database blip) degrades to "no curated synonyms" and is never allowed
 * to fail a buyer's search. The failure is not cached, so the next search tries again.
 */
export async function activeSynonymsOrEmpty(): Promise<SynonymSet> {
  try {
    return await getActiveSynonyms();
  } catch {
    return EMPTY;
  }
}

/** OpenSearch `synonym_graph` lines for the current dictionary (used when an index is (re)built). */
export async function activeSynonymLines(): Promise<string[]> {
  return toSolrLines((await activeSynonymsOrEmpty()).groups);
}

export async function listSynonymVersions(limit = 50): Promise<SynonymVersionSummary[]> {
  const rows = await prisma.searchSynonymVersion.findMany({ orderBy: { version: "desc" }, take: Math.min(200, Math.max(1, limit)) });
  return rows.map(({ id: _id, groups: _g, ...r }) => r);
}

export async function getSynonymVersion(version: number): Promise<SynonymSet | null> {
  const row = await prisma.searchSynonymVersion.findUnique({ where: { version } });
  return row ? { version: row.version, groups: readGroups(row.groups) } : null;
}

interface PublishMeta {
  staffId: string | null;
  note?: string;
  source: SynonymSource;
  basedOnVersion?: number | null;
}

/** Validates and appends the next version. Retries when two publishes race for the same number (unique index on version). */
async function append(input: unknown, meta: PublishMeta): Promise<SynonymSet> {
  const { groups, errors } = checkGroups(input);
  if (errors.length) throw new DomainError("validation", errors.slice(0, 5).join(" "));
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await prisma.searchSynonymVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } });
    const version = (latest?.version ?? 0) + 1;
    try {
      await prisma.searchSynonymVersion.create({
        data: {
          version, groups: groups as unknown as object[], groupCount: groups.length, source: meta.source, basedOnVersion: meta.basedOnVersion ?? latest?.version ?? null,
          note: meta.note?.trim().slice(0, 500) || null, createdByStaffId: meta.staffId,
        },
      });
      invalidateSynonymCache();
      return { version, groups };
    } catch (e) {
      if ((e as { code?: string }).code === "P2002" && attempt < 2) continue; // lost the race: take the next number
      throw e;
    }
  }
  throw new DomainError("conflict", "Could not publish the dictionary, please retry.");
}

/** Publishes `groups` as the new active dictionary. `editedFrom` is the version the editor started from (conflict guard). */
export async function publishSynonyms(groups: unknown, o: { staffId: string; note?: string; editedFrom?: number }): Promise<SynonymSet> {
  if (o.editedFrom !== undefined) {
    const active = (await prisma.searchSynonymVersion.findFirst({ orderBy: { version: "desc" }, select: { version: true } }))?.version ?? 0;
    if (active !== o.editedFrom) throw new DomainError("conflict", `Someone published version ${active} while you were editing version ${o.editedFrom}. Reload and re-apply your change.`);
  }
  return append(groups, { staffId: o.staffId, note: o.note, source: "edit", basedOnVersion: o.editedFrom ?? null });
}

/** Rollback = publish a COPY of an older snapshot as the newest version; history is untouched. */
export async function rollbackSynonyms(toVersion: number, o: { staffId: string; note?: string }): Promise<SynonymSet> {
  const target = await getSynonymVersion(toVersion);
  if (!target) throw new DomainError("not_found", `Synonym version ${toVersion} does not exist.`);
  return append(target.groups, { staffId: o.staffId, note: o.note ?? `Rollback to version ${toVersion}`, source: "rollback", basedOnVersion: toVersion });
}

/** Where the Solr-format starter set lives (also loaded by the OpenSearch mapping when no managed package is set). */
export const BUILT_IN_SYNONYMS_FILE = new URL("../../synonyms/hinglish-b2b.txt", import.meta.url);

/** One-click import of the repo's starter dictionary: merged into the active groups (existing groups kept), new version. */
export async function importBuiltInSynonyms(o: { staffId: string | null }, file: URL | string = BUILT_IN_SYNONYMS_FILE): Promise<SynonymSet> {
  invalidateSynonymCache(); // merge into what is stored NOW, not a cached copy
  const active = await getActiveSynonyms();
  const imported = parseSolr(readFileSync(file, "utf8"));
  return append([...active.groups, ...imported], { staffId: o.staffId, note: "Imported starter dictionary (synonyms/hinglish-b2b.txt)", source: o.staffId ? "import" : "seed" });
}
