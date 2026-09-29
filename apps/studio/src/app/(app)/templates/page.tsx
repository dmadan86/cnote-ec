import { getStorefront, listTemplates, mergeSellerData, type TemplateView } from "@cnote/storefront";
import { Alert, Badge, buttonClasses, Card, CardBody, Container, EmptyState, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { applyTemplateFormAction } from "@/features/studio/actions";
import { TemplateThumb } from "@/features/studio/template-thumb";
import { requireSellerSession } from "@/lib/auth";

export const metadata = { title: "Templates" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const label = (s: string) => s.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
const href = (vertical?: string, tag?: string) => `/templates${vertical || tag ? `?${new URLSearchParams({ ...(vertical ? { vertical } : {}), ...(tag ? { tag } : {}) })}` : ""}`;

export default async function Templates(props: PageProps<"/templates">) {
  const session = await requireSellerSession("/templates");
  const sp = await props.searchParams;
  const vertical = first(sp.vertical);
  const tag = first(sp.tag);
  const error = first(sp.error);
  const [all, sf] = await Promise.all([listTemplates(), getStorefront(session.business!.id)]);
  const shown: TemplateView[] = all.filter((t) => (!vertical || t.verticals.includes(vertical) || t.verticals.length === 0) && (!tag || t.tags.includes(tag)));
  const verticals = [...new Set(all.flatMap((t) => t.verticals))].sort();
  const tags = [...new Set(all.flatMap((t) => t.tags))].sort();

  return (
    <Container className="space-y-6 py-8">
      <PageHeader title="Choose a template" description="Every template uses your real business details, live listings, verification and buyer reviews. You can change everything afterwards." />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {sf ? <Alert tone="info">Applying a template starts a fresh draft. Your current draft stays in Version history, so nothing is lost.</Alert> : null}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3" role="group" aria-label="Filter templates">
        <FilterRow title="Industry" all={href(undefined, tag)} active={vertical} items={verticals.map((v) => ({ id: v, href: href(v, tag) }))} />
        <FilterRow title="Style" all={href(vertical, undefined)} active={tag} items={tags.map((t) => ({ id: t, href: href(vertical, t) }))} />
      </div>

      {shown.length === 0 ? (
        <EmptyState title="No templates match" description="Try clearing a filter." action={<Link href="/templates" className={buttonClasses("outline")}>Clear filters</Link>} />
      ) : (
        <ul className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fill, 320px)" }}>
          {shown.map((t) => (
            <li key={t.key}>
              <Card className="w-[320px] overflow-hidden">
                <TemplateThumb document={mergeSellerData(t.document, { name: "Your Business", city: "Your City" })} />
                <CardBody className="space-y-3 p-4">
                  <div>
                    <h2 className="text-base font-bold text-ink">{t.name}</h2>
                    <p className="mt-1 line-clamp-3 text-sm text-muted">{t.description}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">{t.tags.slice(0, 4).map((x) => <Badge key={x} tone="neutral">{label(x)}</Badge>)}</div>
                  <div className="flex gap-2">
                    <form action={applyTemplateFormAction}>
                      <input type="hidden" name="key" value={t.key} />
                      <button type="submit" className={buttonClasses("primary", "sm")} aria-label={`Use the ${t.name} template`}>Use template</button>
                    </form>
                    <Link href={`/templates/${t.key}`} className={buttonClasses("outline", "sm")} aria-label={`Preview the ${t.name} template`}>Preview</Link>
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </Container>
  );
}

function FilterRow({ title, all, active, items }: { title: string; all: string; active?: string; items: { id: string; href: string }[] }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-sm font-medium text-ink">{title}:</span>
      <Link href={all} aria-current={!active ? "true" : undefined} className={chip(!active)}>All</Link>
      {items.map((i) => <Link key={i.id} href={i.href} aria-current={active === i.id ? "true" : undefined} className={chip(active === i.id)}>{label(i.id)}</Link>)}
    </div>
  );
}
const chip = (on: boolean) => `inline-flex h-8 items-center rounded-full border px-3 text-sm focus-visible:outline-2 focus-visible:outline-brand-600 ${on ? "border-brand-600 bg-brand-50 font-semibold text-brand-700" : "border-line bg-surface text-ink hover:bg-canvas"}`;
