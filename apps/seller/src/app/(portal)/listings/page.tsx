import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Alert, Card, CardBody, EmptyState, Money, PageHeader, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";
import { ListingStatusBadges } from "@/features/listings/status-badges";
import { ListingRowActions } from "@/features/listings/row-actions";

export const metadata: Metadata = { title: "Listings" };

export default async function ListingsPage() {
  const session = await requireSeller("/listings");
  const res = await load(() => catalogue.listSellerListings(session.business.id));
  return (
    <div className="space-y-6">
      <PageHeader
        title="Your listings"
        description="Buyers and lead matching use your published listings. Every listing is checked against our prohibited-category policy."
        actions={
          <Link href="/listings/new" className={buttonClasses("primary", "md", "min-h-11")}>
            <Plus className="size-4" aria-hidden /> New listing
          </Link>
        }
      />
      {!res.ok ? (
        <Alert tone="danger">{res.error}</Alert>
      ) : res.data.length === 0 ? (
        <EmptyState
          title="Post your first listing"
          description="Describe what you sell in a few lines and AI will draft it for you. Without a published listing you cannot be matched to buyers."
          action={<Link href="/listings/new" className={buttonClasses("primary", "lg")}>Create a listing</Link>}
        />
      ) : (
        <ul className="grid gap-3">
          {res.data.map((l) => (
            <li key={l.id}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <h2 className="truncate font-semibold text-ink">{l.title}</h2>
                      <p className="text-sm text-muted">{l.category.name}</p>
                    </div>
                    <div className="text-sm">
                      {l.pricePaise != null ? <Money paise={l.pricePaise} unit={l.priceUnit} /> : <span className="text-muted">Ask for price</span>}
                      {l.moq ? <p className="text-muted">Min. order: {l.moq} {l.moqUnit}</p> : null}
                    </div>
                  </div>
                  <ListingStatusBadges listing={l} />
                  {l.moderationStatus === "rejected" && l.moderationReason ? <p className="text-sm text-danger">{l.moderationReason}</p> : null}
                  <div className="flex flex-wrap items-start gap-2">
                    {l.status !== "archived" ? (
                      <Link href={`/listings/${l.id}/edit`} className={buttonClasses("outline", "sm", "min-h-11")}>
                        Edit
                      </Link>
                    ) : null}
                    <ListingRowActions id={l.id} canPublish={l.status === "draft"} canArchive={l.status !== "archived"} />
                  </div>
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
