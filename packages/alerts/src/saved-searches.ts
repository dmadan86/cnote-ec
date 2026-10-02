// Saved searches. "Save this search" on /search stores the query + filters; a job (digests.ts) reports NEW matches through the
// search module's public API. A saved search is a private convenience: it never changes anyone's ranking (ADR-000/009).
import { createHash } from "node:crypto";
import { DomainError } from "@cnote/core";
import { prisma } from "@cnote/db";
import { filtersSchema, hasActiveFilters, isSearchSort, normaliseFilters, searchListings, type SearchFilters } from "@cnote/search";
import { z } from "zod";
import { throttle } from "./follows";
import { MAX_SAVED_SEARCHES_PER_PERSON, MAX_SEEN_IDS, SEARCH_FREQUENCIES, type SavedSearchView, type SearchFrequency } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inputSchema = z.object({
  query: z.string().trim().max(200).default(""),
  filters: filtersSchema.optional(),
  sort: z.string().default("relevance"),
  name: z.string().trim().max(80).optional(),
  frequency: z.enum(SEARCH_FREQUENCIES).default("off"),
});
export interface SaveSearchInput {
  query?: string;
  filters?: SearchFilters;
  sort?: string;
  name?: string;
  frequency?: SearchFrequency;
}

const fingerprintOf = (query: string, filters: SearchFilters, sort: string) =>
  createHash("sha256").update(JSON.stringify([query.toLowerCase().replace(/\s+/g, " "), filters, sort])).digest("hex").slice(0, 32);

type Row = { id: string; name: string; query: string; filters: unknown; sort: string; frequency: string; lastRunAt: Date | null; createdAt: Date };
const toView = (r: Row): SavedSearchView => ({
  id: r.id,
  name: r.name,
  query: r.query,
  filters: (r.filters ?? {}) as Record<string, unknown>,
  sort: r.sort,
  frequency: (SEARCH_FREQUENCIES as readonly string[]).includes(r.frequency) ? (r.frequency as SearchFrequency) : "off",
  lastRunAt: r.lastRunAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** Listing ids a search matches right now, newest first (the digest compares against what it has already reported). */
export async function currentMatchIds(query: string, filters: SearchFilters): Promise<string[]> {
  const r = await searchListings({ q: query, filters, sort: "newest", limit: 50 });
  return r.hits.map((h) => h.listing.id);
}

const trimSeen = (current: string[], seen: string[]) => [...new Set([...current, ...seen])].slice(0, MAX_SEEN_IDS);

/**
 * Saves a search. The listings matching it today are recorded as "already seen", so the first digest only reports what is new
 * after this moment. Saving the same query + filters twice is a "conflict". `frequency` defaults to "off" (alerts are opt-in).
 */
export async function createSavedSearch(personId: string, input: SaveSearchInput): Promise<SavedSearchView> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new DomainError("validation", "That search can't be saved", undefined, "alerts.invalidSearch");
  const filters = normaliseFilters(parsed.data.filters);
  const query = parsed.data.query;
  const sort = isSearchSort(parsed.data.sort) ? parsed.data.sort : "relevance";
  if (!query && !hasActiveFilters(filters)) throw new DomainError("validation", "Enter a search or choose a filter before saving", undefined, "alerts.emptySearch");
  await throttle(personId, "search");
  const fingerprint = fingerprintOf(query, filters, sort);
  const name = parsed.data.name || query || "All products";
  let seen: string[] = [];
  let baselined = false;
  try {
    seen = await currentMatchIds(query, filters);
    baselined = true;
  } catch {
    /* search unavailable: the first job run takes the baseline silently instead */
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`saved-searches:${personId}`}))`;
    if (await tx.savedSearch.findUnique({ where: { personId_fingerprint: { personId, fingerprint } }, select: { id: true } })) {
      throw new DomainError("conflict", "You already saved this search", undefined, "alerts.searchAlreadySaved");
    }
    if ((await tx.savedSearch.count({ where: { personId } })) >= MAX_SAVED_SEARCHES_PER_PERSON) {
      throw new DomainError("validation", `You can save up to ${MAX_SAVED_SEARCHES_PER_PERSON} searches`, undefined, "alerts.upSearches", { max: MAX_SAVED_SEARCHES_PER_PERSON });
    }
    return toView(
      await tx.savedSearch.create({
        data: { personId, name, query, filters, sort, fingerprint, frequency: parsed.data.frequency, seenListingIds: trimSeen(seen, []), lastRunAt: baselined ? new Date() : null },
      }),
    );
  });
}

export async function listSavedSearches(personId: string): Promise<SavedSearchView[]> {
  return (await prisma.savedSearch.findMany({ where: { personId }, orderBy: { createdAt: "desc" }, take: MAX_SAVED_SEARCHES_PER_PERSON })).map(toView);
}

async function owned(personId: string, id: string) {
  if (!UUID.test(id)) throw new DomainError("not_found", "Saved search not found", undefined, "alerts.searchNotFound");
  const row = await prisma.savedSearch.findUnique({ where: { id } });
  if (!row || row.personId !== personId) throw new DomainError("not_found", "Saved search not found", undefined, "alerts.searchNotFound");
  return row;
}

/** Changes how often the digest arrives ("off" pauses it). Switching on restarts the window now, so there is no backlog blast. */
export async function setSearchFrequency(personId: string, id: string, frequency: SearchFrequency): Promise<SavedSearchView> {
  if (!(SEARCH_FREQUENCIES as readonly string[]).includes(frequency)) throw new DomainError("validation", "Choose off, daily or weekly", undefined, "alerts.invalidFrequency");
  const row = await owned(personId, id);
  await throttle(personId, "search");
  let seen = row.seenListingIds as string[];
  if (frequency !== "off" && row.frequency === "off") {
    // re-baseline: whatever matches now counts as seen, so only listings appearing from here on are reported
    try {
      seen = trimSeen(await currentMatchIds(row.query, (row.filters ?? {}) as SearchFilters), seen);
    } catch {
      /* keep the old baseline */
    }
  }
  return toView(await prisma.savedSearch.update({ where: { id }, data: { frequency, seenListingIds: seen, ...(frequency !== "off" && row.frequency === "off" ? { lastRunAt: new Date() } : {}) } }));
}

export async function deleteSavedSearch(personId: string, id: string): Promise<void> {
  await owned(personId, id);
  await prisma.savedSearch.deleteMany({ where: { id, personId } });
}
