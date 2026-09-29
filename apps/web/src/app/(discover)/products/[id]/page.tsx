import { notFound, permanentRedirect } from "next/navigation";
import { isUuid, productPath } from "@/lib/paths";
import { isPublic, loadListing } from "@/features/search/data";

// Legacy URL /products/<uuid> -> canonical /p/<slug>-<uuid> (308, cached with the ISR entry).
export const revalidate = 3600;

export default async function LegacyProductRedirect(props: PageProps<"/products/[id]">) {
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const l = await loadListing(id);
  if (!l || !isPublic(l)) notFound();
  permanentRedirect(productPath(l));
}
