import { getTemplate, mergeSellerData } from "@cnote/storefront";
import { StorefrontView, findPage, type RenderHrefs } from "@cnote/storefront/render";
import { buttonClasses, Container } from "@cnote/ui";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { applyTemplateFormAction } from "@/features/studio/actions";
import { SAMPLE_DATA } from "@/features/studio/sample-data";
import { requireSellerSession } from "@/lib/auth";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function TemplatePreview(props: PageProps<"/templates/[key]">) {
  const { key } = await props.params;
  await requireSellerSession(`/templates/${key}`);
  const tpl = await getTemplate(key);
  if (!tpl || !tpl.active) notFound();
  const page = findPage(tpl.document, first((await props.searchParams).page));
  const doc = mergeSellerData(tpl.document, { name: SAMPLE_DATA.business.name, city: SAMPLE_DATA.business.city });
  const hrefs: RenderHrefs = { page: (p) => `/templates/${key}?page=${p}`, product: () => "#", rfq: "#" };
  return (
    <div>
      <div className="border-b border-line bg-surface">
        <Container className="flex flex-wrap items-center gap-3 py-3">
          <Link href="/templates" className={buttonClasses("ghost", "sm")}><ArrowLeft className="size-4" aria-hidden /> All templates</Link>
          <h1 className="text-base font-bold text-ink">{tpl.name}</h1>
          <span className="text-sm text-muted">Preview with sample data. Your real business details, products and reviews replace it.</span>
          <form action={applyTemplateFormAction} className="ml-auto">
            <input type="hidden" name="key" value={tpl.key} />
            <button type="submit" className={buttonClasses("primary", "sm")}>Use this template</button>
          </form>
        </Container>
      </div>
      <StorefrontView document={doc} pageSlug={page.slug} data={SAMPLE_DATA} hrefs={hrefs} preview />
    </div>
  );
}
