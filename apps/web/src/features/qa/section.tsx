import { getTranslations } from "next-intl/server";
import { loadQaPage } from "@/features/search/data";
import { QaAskPanel } from "./ask-panel";
import { QaList } from "./qa-list";

/**
 * "Questions about this product": public answered Q&A (static HTML, first page) plus client islands for search / more /
 * the viewer's own questions / the ask form. Cache-friendly: nothing here reads cookies. Purged by `qa:<listingId>`.
 */
export async function ProductQa({ listingId, locale }: { listingId: string; locale: string }) {
  const t = await getTranslations({ locale, namespace: "qa" });
  const initial = await loadQaPage(listingId);
  return (
    <section id="questions" aria-labelledby="questions-h" className="space-y-4">
      <div>
        <h2 id="questions-h" className="text-xl font-bold text-ink">{t("title")}</h2>
        <p className="mt-1 text-sm text-muted">{t("intro")}</p>
      </div>
      <QaList listingId={listingId} initial={initial} />
      <QaAskPanel listingId={listingId} />
    </section>
  );
}
