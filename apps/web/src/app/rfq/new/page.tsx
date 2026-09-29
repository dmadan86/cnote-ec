import { listCategories } from "@cnote/catalogue";
import { requireBusiness } from "@cnote/next-kit";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { RfqForm } from "@/features/enquiry/rfq-form";

export const metadata: Metadata = { title: "Post your requirement" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewRfqPage(props: PageProps<"/rfq/new">) {
  const sp = await props.searchParams;
  const q = first(sp.q)?.slice(0, 140);
  const listing = first(sp.listing);
  const category = first(sp.category);
  const qs = new URLSearchParams();
  for (const [k, v] of [["q", q], ["listing", listing], ["category", category]] as const) if (v) qs.set(k, v);
  await requireBusiness(`/rfq/new${qs.size ? `?${qs}` : ""}`);

  const categories = (await listCategories()).filter((c) => !c.prohibited).map((c) => ({ slug: c.slug, name: c.name }));
  return (
    <Container className="max-w-3xl py-8">
      <PageHeader title="Post your requirement" description="Tell us what you need. We offer it to up to 3 relevant, trust-ranked sellers, not everyone." />
      <div className="mt-6">
        <RfqForm
          categories={categories}
          defaults={{
            title: q,
            requirement: q,
            categorySlug: categories.some((c) => c.slug === category) ? category : undefined,
            preferredListingId: listing && /^[0-9a-f-]{36}$/i.test(listing) ? listing : undefined,
          }}
        />
      </div>
    </Container>
  );
}
