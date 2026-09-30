import { listCategories } from "@cnote/catalogue";
import { requireBusiness } from "@cnote/next-kit";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RfqForm } from "@/features/enquiry/rfq-form";

export const metadata: Metadata = { title: "Post your requirement" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f-]{36}$/i;

export default async function NewRfqPage(props: PageProps<"/rfq/new">) {
  const t = await getTranslations({ locale: "en", namespace: "rfq" });
  const sp = await props.searchParams;
  const q = first(sp.q)?.slice(0, 140);
  const listing = first(sp.listing);
  const category = first(sp.category);
  const seller = first(sp.seller);
  const qs = new URLSearchParams();
  for (const [k, v] of [["q", q], ["listing", listing], ["category", category], ["seller", seller]] as const) if (v) qs.set(k, v);
  await requireBusiness(`/rfq/new${qs.size ? `?${qs}` : ""}`);

  const categories = (await listCategories()).filter((c) => !c.prohibited).map((c) => ({ slug: c.slug, name: c.name }));
  return (
    <Container className="max-w-3xl py-8">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <div className="mt-6">
        <RfqForm
          categories={categories}
          defaults={{
            title: q,
            requirement: q,
            categorySlug: categories.some((c) => c.slug === category) ? category : undefined,
            preferredListingId: listing && UUID.test(listing) ? listing : undefined,
            // From a seller's storefront "Request quote": prefer that seller if it is an eligible match.
            preferredSellerId: seller && UUID.test(seller) ? seller : undefined,
          }}
        />
      </div>
    </Container>
  );
}
