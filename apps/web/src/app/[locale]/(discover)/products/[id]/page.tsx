import { notFound, permanentRedirect } from "next/navigation";
import { localizePath } from "@/i18n/config";
import { resolveLocale } from "@/i18n/server";
import { isUuid, productPath } from "@/lib/paths";
import { isPublic, loadListing } from "@/features/search/data";

// Legacy URL /products/<uuid> -> canonical /p/<slug>-<uuid> (308, cached with the ISR entry), keeping the locale.
export const revalidate = 3600;

export default async function LegacyProductRedirect(props: PageProps<"/[locale]/products/[id]">) {
  const locale = await resolveLocale(props.params);
  const { id } = await props.params;
  if (!isUuid(id)) notFound();
  const l = await loadListing(id);
  if (!l || !isPublic(l)) notFound();
  permanentRedirect(localizePath(productPath(l), locale));
}
