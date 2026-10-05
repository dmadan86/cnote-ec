import { listCategories } from "@cnote/catalogue";
import { getBuyerEnquiry, getOrder } from "@cnote/enquiry";
import { actorOf, requireBusiness } from "@cnote/next-kit";
import { Alert, Container, PageHeader } from "@cnote/ui";
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
type Session = Awaited<ReturnType<typeof requireBusiness>>;
const paiseToRupees = (p: number | null) => (p === null ? undefined : String(p / 100));

/**
 * "Request again" (docs/design/buyer-retention.md): defaults copied from the buyer's OWN earlier requirement or order. Ownership is
 * enforced by the enquiry module's getters, which return null for anyone else's. The same supplier is offered as a checkbox: a
 * "preferred seller" only bumps them in matching (ADR-002); nothing is sent until the buyer submits the form.
 */
async function loadPrefill(s: Session, enquiryId: string | undefined, orderId: string | undefined) {
  const order = orderId ? await getOrder(actorOf(s), orderId).catch(() => null) : null;
  const buyerOrder = order && order.role === "buyer" ? order : null;
  const eid = enquiryId ?? buyerOrder?.enquiryId ?? undefined;
  const e = eid ? await getBuyerEnquiry(s.business.id, eid).catch(() => null) : null;
  if (!e && !buyerOrder) return null;
  const match = e ? (e.matches.find((m) => m.status === "accepted") ?? [...e.matches].sort((a, b) => a.rank - b.rank)[0]) : undefined;
  const supplier = buyerOrder ? { id: buyerOrder.counterparty.businessId, name: buyerOrder.counterparty.name } : match ? { id: match.sellerBusinessId, name: match.sellerName } : undefined;
  const title = e?.title ?? buyerOrder?.enquiryTitle ?? "";
  return {
    title,
    fromOrder: !!buyerOrder && !enquiryId,
    defaults: {
      title,
      requirement: e?.requirement ?? title,
      categorySlug: e?.category?.slug,
      quantity: buyerOrder?.quantity ?? e?.quantity ?? undefined,
      unit: buyerOrder?.unit ?? e?.quantityUnit ?? undefined,
      targetPriceRupees: paiseToRupees(e?.targetPricePaise ?? null),
      deliveryCity: e?.deliveryCity ?? undefined,
      deliveryPincode: e?.deliveryPincode ?? undefined,
      budgetMinRupees: paiseToRupees(e?.budgetMinPaise ?? null),
      budgetMaxRupees: paiseToRupees(e?.budgetMaxPaise ?? null),
      minSellerTier: e?.minSellerTier ?? undefined,
      sameSupplier: supplier,
    },
  };
}

export default async function NewRfqPage(props: PageProps<"/rfq/new">) {
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "rfq" });
  const tr = await getTranslations({ locale, namespace: "retention" });
  const tv = await getTranslations({ locale, namespace: "pdp" });
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
  // The variant chosen on the product page: its SKU and a readable name become a line of the requirement.
  const variantRaw = first(sp.variant);
  const variantSku = variantRaw && /^[A-Za-z0-9._-]{1,64}$/.test(variantRaw) ? variantRaw : undefined;
  const variantLabel = variantSku ? first(sp.vlabel)?.replace(/[\r\n]+/g, " ").slice(0, 140) : undefined;
  // "Request again": ?again=<enquiryId> and/or ?order=<orderId>
  const againRaw = first(sp.again);
  const orderRaw = first(sp.order);
  const again = againRaw && UUID.test(againRaw) ? againRaw : undefined;
  const orderId = orderRaw && UUID.test(orderRaw) ? orderRaw : undefined;
  const qs = new URLSearchParams();
  for (const [k, v] of [["q", q], ["listing", listing], ["category", category], ["seller", seller], ["qty", qty?.toString()], ["unit", unit], ["price", pricePaise?.toString()], ["variant", variantSku], ["vlabel", variantLabel], ["again", again], ["order", orderId]] as const) if (v) qs.set(k, v);
  const session = await requireBusiness(`/rfq/new${qs.size ? `?${qs}` : ""}`);
  const prefill = again || orderId ? await loadPrefill(session, again, orderId) : null;

  const categories = (await listCategories()).filter((c) => !c.prohibited).map((c) => ({ slug: c.slug, name: c.name }));
  const defaults = prefill
    ? { ...prefill.defaults, categorySlug: categories.some((c) => c.slug === prefill.defaults.categorySlug) ? prefill.defaults.categorySlug : undefined }
    : {
        title: q,
        requirement: [q, variantSku ? tv("requirementLine", { label: variantLabel || variantSku, sku: variantSku }) : undefined].filter(Boolean).join("\n") || undefined,
        categorySlug: categories.some((c) => c.slug === category) ? category : undefined,
        preferredListingId: listing && UUID.test(listing) ? listing : undefined,
        // From a seller's storefront "Request quote": prefer that seller if it is an eligible match.
        preferredSellerId: seller && UUID.test(seller) ? seller : undefined,
        quantity: qty,
        unit,
        targetPriceRupees: pricePaise !== undefined ? String(pricePaise / 100) : undefined,
      };
  return (
    <Container className="max-w-3xl py-8">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <div className="mt-6">
        {prefill ? <Alert tone="info" className="mb-4">{tr(prefill.fromOrder ? "again.bannerOrder" : "again.banner", { title: prefill.title })}</Alert> : null}
        {(again || orderId) && !prefill ? <Alert tone="warning" className="mb-4">{tr("again.notFound")}</Alert> : null}
        <PriceHint locale={locale} />
        <RfqForm categories={categories} defaults={defaults} />
      </div>
    </Container>
  );
}
