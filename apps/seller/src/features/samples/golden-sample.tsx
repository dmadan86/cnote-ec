import Link from "next/link";
import Image from "next/image";
import { getLocale, getTranslations } from "next-intl/server";
import { Card, CardBody, CardHeader, CardTitle } from "@cnote/ui";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { getGoldenSampleForOrder, samplesEnabled, type Actor } from "@/lib/samples";

/**
 * The sample the buyer approved behind this order: the quality reference bulk supply should match. Renders nothing while
 * SAMPLES_ENABLED is off or when no approved sample is linked to the order.
 */
export async function GoldenSample({ orderId, actor }: { orderId: string; actor: Actor }) {
  if (!samplesEnabled()) return null;
  const g = await getGoldenSampleForOrder(actor, orderId).catch(() => null);
  if (!g) return null;
  const t = await getTranslations("samples");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  return (
    <section aria-labelledby="golden-sample">
      <Card>
        <CardHeader><CardTitle id="golden-sample">{t("goldenTitle")}</CardTitle></CardHeader>
        <CardBody className="space-y-3 text-sm">
          <p className="text-muted">{t("goldenIntro", { date: formatDate(g.approvedAt, locale) })}</p>
          <p className="font-medium text-ink">{g.subject}</p>
          {g.notes ? <p className="text-ink">{g.notes}</p> : null}
          {g.photos.length ? (
            <ul className="flex flex-wrap gap-2">
              {g.photos.map((p, i) => (
                <li key={p.id}><Image unoptimized src={`/samples/${g.id}/photos/${p.id}`} alt={t("photoAlt", { n: i + 1 })} width={96} height={96} className="size-24 rounded-md border border-line object-cover" /></li>
              ))}
            </ul>
          ) : null}
          <Link href={`/samples/${g.id}`} className="inline-flex min-h-11 items-center font-medium text-brand-700 underline">{t("viewSample")}</Link>
        </CardBody>
      </Card>
    </section>
  );
}
