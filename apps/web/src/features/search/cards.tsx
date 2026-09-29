import Link from "next/link";
import type { ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";
import { ProductCard, SellerCard } from "@cnote/ui";
import { productPath, sellerPath } from "@/lib/paths";
import { RatingStars } from "@/features/reviews/stars";
import { CompareIsland, SaveIsland } from "@/features/user-state/islands";
import { moqText } from "./format";
import { ProductImage } from "./product-image";

const CARD_SIZES = "(min-width: 1280px) 12vw, (min-width: 1024px) 20vw, (min-width: 640px) 30vw, 45vw";

/**
 * Product tile. Fully static (no cookies, no session): heart and compare are client islands that read per-user
 * state after hydration, so any page made of these cards can be ISR/CDN cached. Pass `rating` from a batched
 * `loadRatings()` so approved review stars show without a query per card.
 */
export function ListingCard({ listing, seller, priority, rating }: { listing: ListingView; seller?: TrustProfile | null; priority?: boolean; rating?: { average: number; count: number } }) {
  return (
    <ProductCard
      id={listing.id}
      href={productPath(listing)}
      title={listing.title}
      image={<ProductImage src={listing.imageUrls[0]} sizes={CARD_SIZES} priority={priority} />}
      pricePaise={listing.pricePaise}
      priceUnit={listing.priceUnit}
      moqText={moqText(listing)}
      seller={seller ? { name: seller.name, city: seller.city, tier: seller.verificationTier, badgeActive: seller.badgeActive } : null}
      wishlist={<SaveIsland id={listing.id} title={listing.title} />}
      rating={rating ? <RatingStars average={rating.average} count={rating.count} /> : null}
      footer={<CompareIsland id={listing.id} title={listing.title} />}
      linkComponent={Link}
    />
  );
}

export function SellerTile({ seller }: { seller: TrustProfile }) {
  return (
    <SellerCard
      href={sellerPath(seller.businessId)}
      name={seller.name}
      city={seller.city}
      state={seller.state}
      tier={seller.verificationTier}
      badgeActive={seller.badgeActive}
      trustScore={seller.trustScore}
      linkComponent={Link}
    />
  );
}
