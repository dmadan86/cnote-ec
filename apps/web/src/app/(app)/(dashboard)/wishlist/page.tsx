import type { Metadata } from "next";
import Link from "next/link";
import { Heart } from "lucide-react";
import { requireSession } from "@cnote/next-kit";
import { Badge, buttonClasses, Card, CardBody, cn, Container, EmptyState, Money, PageHeader } from "@cnote/ui";
import { getList, getOrCreateDefaultList, getShare, listLists } from "@cnote/wishlist";
import { getTranslations } from "next-intl/server";
import { formatNumber } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { productPath } from "@/lib/paths";
import { moqText } from "@/features/search/format";
import { ProductImage } from "@/features/search/product-image";
import { BulkRfqBar, SelectProduct } from "@/features/wishlist/bulk-rfq";
import { ItemControls } from "@/features/wishlist/item-controls";
import { ShareList } from "@/features/wishlist/share-list";
import { CreateListForm, ManageList } from "@/features/wishlist/list-forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("wishlist"), robots: { index: false } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function WishlistPage(props: PageProps<"/wishlist">) {
  const s = await requireSession("/wishlist");
  const locale = await getRequestLocale();
  const [t, tc] = await Promise.all([getTranslations({ locale, namespace: "wishlist" }), getTranslations({ locale, namespace: "cards" })]);
  const rupee = (paise: number) => `₹${formatNumber(paise / 100, locale, { maximumFractionDigits: 2 })}`;
  const sp = await props.searchParams;
  const wanted = Array.isArray(sp.list) ? sp.list[0] : sp.list;
  await getOrCreateDefaultList(s.personId);
  const lists = await listLists(s.personId);
  const current = lists.find((l) => wanted && UUID.test(wanted) && l.id === wanted) ?? lists[0]!;
  const [detail, share] = await Promise.all([getList(s.personId, current.id), getShare(s.personId, current.id)]);
  const available = detail.items.filter((i) => i.listing);
  const others = lists.filter((l) => l.id !== current.id).map((l) => ({ id: l.id, name: l.name }));

  return (
    <Container className="py-6 lg:py-8">
      <PageHeader title={t("title")} description={t("description")} />
      <div className="mt-6 grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside aria-label={t("listsAria")} className="flex flex-col gap-4">
          <nav aria-label={t("listsNav")}>
            <ul className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
              {lists.map((l) => {
                const active = l.id === current.id;
                return (
                  <li key={l.id} className="shrink-0">
                    <Link
                      href={l.isDefault ? "/wishlist" : `/wishlist?list=${l.id}`}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-brand-600",
                        active ? "border-brand-100 bg-brand-100 text-brand-700" : "border-line bg-surface text-ink hover:bg-canvas",
                      )}
                    >
                      <span className="truncate">{l.name}</span>
                      <span className="text-xs text-muted">{l.itemCount}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
          <CreateListForm />
        </aside>

        <section aria-labelledby="list-title" className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="list-title" className="text-xl font-bold text-ink">
              {detail.name} <span className="text-sm font-normal text-muted">({detail.itemCount})</span>
            </h2>
            {!detail.isDefault ? <ManageList listId={detail.id} name={detail.name} itemCount={detail.itemCount} /> : null}
          </div>

          <ShareList key={detail.id} listId={detail.id} token={share?.token ?? null} />

          {available.length ? <BulkRfqBar listId={detail.id} /> : null}

          {detail.items.length === 0 ? (
            <EmptyState
              title={t("emptyTitle")}
              description={t("emptyDescription")}
              action={
                <Link href="/search" className={buttonClasses("primary")}>
                  <Heart className="size-4" aria-hidden /> {t("browse")}
                </Link>
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {detail.items.map((i) => (
                <li key={i.id}>
                  <Card>
                    <CardBody>
                      <div className="flex gap-3 sm:gap-4">
                        {i.listing ? <SelectProduct listingId={i.listingId} title={i.listing.title} /> : null}
                        <div className="relative size-20 shrink-0 overflow-hidden rounded-lg bg-canvas sm:size-28">
                          <ProductImage src={i.listing?.imageUrls[0]} blur={i.listing?.imageBlurs?.[0]} sizes="112px" />
                        </div>
                        <div className="min-w-0 flex-1">
                          {i.listing ? (
                            <>
                              <h3 className="line-clamp-2 text-sm font-semibold text-ink sm:text-base">
                                <Link href={productPath(i.listing)} className="hover:text-brand-700 hover:underline">
                                  {i.listing.title}
                                </Link>
                              </h3>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                                {i.currentPricePaise != null ? <Money paise={i.currentPricePaise} unit={i.listing.priceUnit} /> : <span className="text-sm text-muted">{tc("priceOnRequest")}</span>}
                                {i.priceDropped && i.savedPricePaise != null ? (
                                  <Badge tone="success">
                                    {t("priceDropped", { price: rupee(i.savedPricePaise) })}
                                  </Badge>
                                ) : null}
                              </div>
                              {moqText(i.listing) ? <p className="mt-1 text-xs text-muted">{tc("minOrder", { value: moqText(i.listing) ?? "" })}</p> : null}
                              <Link href={`/rfq/new?listing=${i.listingId}`} className={buttonClasses("accent", "sm", "mt-2")}>
                                {t("requestQuote")}
                              </Link>
                            </>
                          ) : (
                            <>
                              <h3 className="text-sm font-semibold text-ink">{t("unavailable")}</h3>
                              <p className="mt-1 text-xs text-muted">{t("unavailableHelp")}</p>
                            </>
                          )}
                        </div>
                      </div>
                      <ItemControls listId={detail.id} listingId={i.listingId} title={i.listing?.title ?? t("thisProduct")} note={i.note} otherLists={others} />
                    </CardBody>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Container>
  );
}
