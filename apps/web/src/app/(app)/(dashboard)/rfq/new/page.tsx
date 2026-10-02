import { listCategories } from "@cnote/catalogue";
import { requireBusiness } from "@cnote/next-kit";
import { Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { RfqForm } from "@/features/enquiry/rfq-form";
import { PriceHint } from "@/features/prices/price-hint";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("rfq") };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const UUID = /^[0-9a-f-]{36}$/i;

export default async function NewRfqPage(props: PageProps<"/rfq/new">) {
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "rfq" });
  const sp = await props.searchParams;
  const q = first(sp.q)?.slice(0, 140);
  const listing = first(sp.listing);
  const category = first(sp.category);
  const seller = first(sp.seller);
  // From the product page's quantity box: whole units, unit label, and the slab price (integer paise) for that quantity.
  const qtyRaw = first(sp.qty);
  const qty = qtyRaw && /^\d{1,10}$/.test(qtyRaw) && Number(qtyRaw) >= 1 && Number(qtyRaw) <= 2_000_000_000 ? Number(qtyRaw) : undefined;
  const unit = first(sp.unit)?.slice(0, 20);
  const priceRaw = first(sp.price);
  const pricePaise = priceRaw && /^\d{1,15}$/.test(priceRaw) ? Number(priceRaw) : undefined;
  const qs = new URLSearchParams();
  for (const [k, v] of [["q", q], ["listing", listing], ["category", category], ["seller", seller], ["qty", qty?.toString()], ["unit", unit], ["price", pricePaise?.toString()]] as const) if (v) qs.set(k, v);
  await requireBusiness(`/rfq/new${qs.size ? `?${qs}` : ""}`);

  const categories = (await listCategories()).filter((c) => !c.prohibited).map((c) => ({ slug: c.slug, name: c.name }));
  return (
    <Container className="max-w-3xl py-8">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <div className="mt-6">
        <PriceHint locale={locale} />
        <RfqForm
          categories={categories}
          defaults={{
            title: q,
            requirement: q,
            categorySlug: categories.some((c) => c.slug === category) ? category : undefined,
            preferredListingId: listing && UUID.test(listing) ? listing : undefined,
            // From a seller's storefront "Request quote": prefer that seller if it is an eligible match.
            preferredSellerId: seller && UUID.test(seller) ? seller : undefined,
            quantity: qty,
            unit,
            targetPriceRupees: pricePaise !== undefined ? String(pricePaise / 100) : undefined,
          }}
        />
      </div>
    </Container>
  );
}
