/**
 * Renders schema.org JSON-LD. `<` and the JS line separators are escaped so listing text can never close the
 * script tag or break the payload. Server Component: the data is in the initial HTML for crawlers and LLM fetchers.
 */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

export function JsonLd({ data }: { data: Record<string, unknown> | Record<string, unknown>[] }) {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll(LS, "\\u2028").replaceAll(PS, "\\u2029");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
