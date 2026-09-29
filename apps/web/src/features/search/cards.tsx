import Link from "next/link";
import type { ListingView } from "@cnote/catalogue";
import type { TrustProfile } from "@cnote/identity";
import { CompareToggle, ProductCard, SellerCard } from "@cnote/ui";
import { toggleCompareAction } from "@/features/compare/actions";
import { readCompareIds } from "@/features/compare/state";
import { toggleSavedAction } from "@/features/wishlist/actions";
import { loadSavedState } from "@/features/wishlist/saved";
import { moqText } from "./format";
import { ProductImage } from "./product-image";

const CARD_SIZES = "(min-width: 1024px) 20vw, (min-width: 640px) 30vw, 45vw";

export async function ListingCard({ listing, seller, priority }: { listing: ListingView; seller?: TrustProfile | null; priority?: boolean }) {
  const [{ signedIn, saved }, tray] = await Promise.all([loadSavedState(), readCompareIds()]);
  return (
    <ProductCard
      id={listing.id}
      href={`/products/${listing.id}`}
      title={listing.title}
      image={<ProductImage src={listing.imageUrls[0]} sizes={CARD_SIZES} priority={priority} />}
      pricePaise={listing.pricePaise}
      priceUnit={listing.priceUnit}
      moqText={moqText(listing)}
      seller={seller ? { name: seller.name, city: seller.city, tier: seller.verificationTier, badgeActive: seller.badgeActive } : null}
      saved={saved.has(listing.id)}
      onToggleSaved={signedIn ? toggleSavedAction : undefined}
      footer={<CompareToggle id={listing.id} title={listing.title} inTray={tray.includes(listing.id)} onToggle={toggleCompareAction} />}
      linkComponent={Link}
    />
  );
}

export function SellerTile({ seller }: { seller: TrustProfile }) {
  return (
    <SellerCard
      href={`/manufacturers/${seller.businessId}`}
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
