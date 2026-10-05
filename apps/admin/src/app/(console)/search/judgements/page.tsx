import { hasPrivilege } from "@cnote/admin";
import { judgedQueries, listJudgements, productKeyOf, searchBackendName, searchListings } from "@cnote/search";
import { Alert, Badge, EmptyState } from "@cnote/ui";
import Link from "next/link";
import { FilterActions, FilterBar, FilterField, FilterInput, FilterSelect } from "@/components/filters";
import { Table, Td, Th } from "@/components/table";
import { DeleteJudgementForm, JudgeForm } from "@/features/search/forms";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Relevance judgements" };
export const dynamic = "force-dynamic";

const LANGS = ["en", "hinglish", "hi", "mr", "gu", "kn", "ta", "te", "bn", "mixed"];

export default async function JudgementsPage({ searchParams }: PageProps<"/search/judgements">) {
  const sp = await searchParams;
  const { staff } = await requireStaff("/search/judgements", "search.read");
  const canManage = hasPrivilege(staff, "search.manage");
  const q = one(sp.q);
  const lang = LANGS.includes(one(sp.lang) ?? "") ? one(sp.lang)! : "en";
  const backend = searchBackendName();

  const [results, mine, queries] = await Promise.all([
    q ? safe("search.judge.results", () => searchListings({ q, limit: 20 })) : Promise.resolve(null),
    q ? safe("search.judge.mine", () => listJudgements({ query: q })) : Promise.resolve(null),
    safe("search.judge.queries", () => judgedQueries(50)),
  ]);
  const gradeOf = new Map((mine ?? []).map((j) => [j.productKey, j.grade]));

  return (
    <>
      <section aria-labelledby="judge-heading" className="space-y-3">
        <h2 id="judge-heading" className="text-base font-semibold">Judge live results</h2>
        <p className="text-sm text-muted">
          Run a buyer query, then grade each result: <strong>3</strong> ideal, <strong>2</strong> relevant, <strong>1</strong> related, <strong>0</strong> not relevant. Results are stored against the product&apos;s title key, not its id, so
          an export stays meaningful when the catalogue changes. Export the file and score it with <code>pnpm --filter @cnote/search eval:relevance -- --judgements file.json</code>. Judging for backend: <Badge tone="neutral">{backend}</Badge>
        </p>
        <FilterBar label="Run a query to judge">
          <FilterField label="Buyer query" width="2xl">
            <FilterInput name="q" defaultValue={q ?? ""} required maxLength={500} lang="und" placeholder="kapda, कपड़ा, gatte ke dabbe" />
          </FilterField>
          <FilterField label="Language" width="sm">
            <FilterSelect name="lang" defaultValue={lang}>
              {LANGS.map((l) => <option key={l} value={l}>{l}</option>)}
            </FilterSelect>
          </FilterField>
          <FilterActions submitLabel="Search" clearHref={q ? "/search/judgements" : undefined} />
        </FilterBar>
        {!q ? null : results === null ? (
          <Alert tone="warning">Search is currently unavailable.</Alert>
        ) : results.hits.length === 0 ? (
          <EmptyState title="No results" description="Nothing matched this query. If a product should have, that is worth a synonym." />
        ) : (
          <Table>
            <thead><tr><Th>#</Th><Th>Product</Th><Th>Category</Th><Th>Seller</Th><Th>Grade</Th></tr></thead>
            <tbody>
              {results.hits.map((h, i) => {
                const current = gradeOf.get(productKeyOf(h.listing.title)) ?? null;
                return (
                  <tr key={h.listing.id}>
                    <Td className="tabular-nums">{i + 1}</Td>
                    <Td className="max-w-md">{h.listing.title}{current !== null ? <Badge tone="brand" className="ml-2">graded {current}</Badge> : null}</Td>
                    <Td>{h.listing.category.name}</Td>
                    <Td>{h.seller.name ?? ""}</Td>
                    <Td>{canManage ? <JudgeForm p={{ query: q, lang, backend, listingId: h.listing.id, title: h.listing.title, categorySlug: h.listing.category.slug, grade: current }} /> : (current ?? "-")}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </section>

      <section aria-labelledby="done-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="done-heading" className="text-base font-semibold">Judged queries</h2>
          <a href="/search/judgements/export" className="inline-flex min-h-9 items-center rounded-lg border border-line px-3 text-sm font-medium text-brand-700 hover:bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600" download>Export judgements (JSON)</a>
        </div>
        {queries === null ? <Alert tone="warning">Judgements are unavailable.</Alert> : queries.length === 0 ? <EmptyState title="Nothing judged yet" description="Run a query above and grade its results." /> : (
          <Table>
            <thead><tr><Th>Query</Th><Th>Language</Th><Th>Items graded</Th><Th /></tr></thead>
            <tbody>
              {queries.map((r) => (
                <tr key={`${r.lang}:${r.query}`}>
                  <Td lang="und">{r.query}</Td><Td>{r.lang}</Td><Td className="tabular-nums">{r.judged}</Td>
                  <Td className="text-right"><Link href={`/search/judgements?q=${encodeURIComponent(r.query)}&lang=${encodeURIComponent(r.lang)}`} className="text-brand-700 hover:underline">Review</Link></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      {q && mine && mine.length ? (
        <section aria-labelledby="grades-heading" className="space-y-2">
          <h2 id="grades-heading" className="text-base font-semibold">Grades recorded for this query</h2>
          <Table>
            <thead><tr><Th>Product key</Th><Th>Grade</Th><Th>Backend</Th><Th>Updated</Th>{canManage ? <Th /> : null}</tr></thead>
            <tbody>
              {mine.map((j) => (
                <tr key={j.id}>
                  <Td className="font-mono text-xs">{j.productKey}</Td><Td className="tabular-nums">{j.grade}</Td><Td>{j.backend}</Td><Td className="whitespace-nowrap">{fmtDate(j.updatedAt)}</Td>
                  {canManage ? <Td className="text-right"><DeleteJudgementForm id={j.id} /></Td> : null}
                </tr>
              ))}
            </tbody>
          </Table>
        </section>
      ) : null}
    </>
  );
}
