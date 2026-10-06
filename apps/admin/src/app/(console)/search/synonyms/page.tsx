import { hasPrivilege } from "@cnote/admin";
import { expandQuery, formatGroupsText, getActiveSynonyms, listSynonymVersions, normaliseQuery, synonymVariants } from "@cnote/search";
import { Alert, Badge, EmptyState } from "@cnote/ui";
import { FilterActions, FilterBar, FilterField, FilterInput } from "@/components/filters";
import { Table, Td, Th } from "@/components/table";
import { ImportStarterForm, RollbackForm, SynonymEditor } from "@/features/search/forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Search synonyms" };
export const dynamic = "force-dynamic";

export default async function SynonymsPage({ searchParams }: PageProps<"/search/synonyms">) {
  const sp = await searchParams;
  const { staff } = await requireStaff("/search/synonyms", "search.read");
  const canManage = hasPrivilege(staff, "search.manage");
  const [active, versions] = await Promise.all([safe("search.synonyms.active", () => getActiveSynonyms()), safe("search.synonyms.versions", () => listSynonymVersions(30))]);
  const tryQuery = one(sp.try);
  const nq = tryQuery ? normaliseQuery(tryQuery) : null;

  if (active === null) return <Alert tone="warning">The synonym dictionary is currently unavailable.</Alert>;
  return (
    <>
      <section aria-labelledby="try-heading" className="space-y-2">
        <h2 id="try-heading" className="text-base font-semibold">Try a query</h2>
        <FilterBar label="Try a search query" action="/search/synonyms">
          <FilterField label="Query" width="2xl">
            <FilterInput name="try" defaultValue={tryQuery ?? ""} placeholder="kapda chahiye, कपड़ा, cotton कपड़ा" lang="und" />
          </FilterField>
          <FilterActions submitLabel="Expand" clearHref={tryQuery ? "/search/synonyms" : undefined} />
        </FilterBar>
        {nq ? (
          <div className="rounded-lg border border-line bg-surface p-3 text-sm">
            <p>Search text after cleaning: <strong lang="und">{nq.text || "(empty)"}</strong>{nq.location ? <> · place hint: {nq.location}</> : null}</p>
            <p className="mt-2 font-medium">From this dictionary (OR-ed into the search, and the first Latin one is embedded):</p>
            <VariantList items={synonymVariants(nq.text, active.groups)} />
            <p className="mt-2 font-medium">Built-in transliteration and lexicon:</p>
            <VariantList items={expandQuery(nq.text)} />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="edit-heading" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="edit-heading" className="text-base font-semibold">
            Dictionary {active.version ? <>version {active.version} <span className="text-sm font-normal text-muted">({active.groups.length} groups)</span></> : <span className="text-sm font-normal text-muted">(nothing published yet)</span>}
          </h2>
          {canManage ? <ImportStarterForm /> : null}
        </div>
        <p className="text-sm text-muted">
          Staff-curated synonyms add extra lexical variants to every search, on Postgres full-text and OpenSearch alike, and the first Latin variant is also used for the semantic (vector) leg.
          They sit on top of the built-in lexicon and never replace what the buyer typed. Edits are versioned, audited and can be rolled back.
        </p>
        {canManage ? <SynonymEditor text={formatGroupsText(active.groups)} version={active.version} /> : <Alert tone="info">Your role can view the dictionary but not change it.</Alert>}
      </section>

      <section aria-labelledby="hist-heading" className="space-y-2">
        <h2 id="hist-heading" className="text-base font-semibold">History</h2>
        {versions === null ? <Alert tone="warning">History is unavailable.</Alert> : versions.length === 0 ? <EmptyState title="No versions yet" description="Publish the first dictionary above, or import the starter set." /> : (
          <Table>
            <thead><tr><Th>Version</Th><Th>Published</Th><Th>Source</Th><Th>Groups</Th><Th>Note</Th><Th>By</Th>{canManage ? <Th /> : null}</tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <Td className="tabular-nums">v{v.version} {v.version === active.version ? <Badge tone="success">active</Badge> : null}</Td>
                  <Td className="whitespace-nowrap">{fmtDate(v.createdAt)}</Td>
                  <Td>{v.source}{v.basedOnVersion ? ` (from v${v.basedOnVersion})` : ""}</Td>
                  <Td className="tabular-nums">{v.groupCount}</Td>
                  <Td className="max-w-md">{v.note ?? ""}</Td>
                  <Td className="font-mono text-xs">{v.createdByStaffId?.slice(0, 8) ?? "system"}</Td>
                  {canManage ? <Td className="text-right">{v.version === active.version ? null : <RollbackForm version={v.version} />}</Td> : null}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>
    </>
  );
}

function VariantList({ items }: { items: string[] }) {
  if (!items.length) return <p className="text-muted">None.</p>;
  return (
    <ul className="mt-1 flex flex-wrap gap-2">
      {items.map((v) => <li key={v} lang="und" className="rounded bg-canvas px-2 py-0.5">{v}</li>)}
    </ul>
  );
}
