import { Card, CardBody, CardTitle } from "@cnote/ui";
import Link from "next/link";
import Image from "next/image";
import { formatDate, type Locale } from "@/i18n/config";
import { getGoldenSampleForOrder, samplesEnabled, type Actor } from "@/lib/samples";
import { fill, sampleLabels } from "./labels";

/**
 * The approved sample behind an order, on the buyer's order page: the quality reference the bulk supply should match.
 * Renders nothing while SAMPLES_ENABLED is off or when no approved sample is linked to the order.
 */
export async function GoldenSample({ orderId, actor, locale = "en" }: { orderId: string; actor: Actor; locale?: Locale }) {
  if (!samplesEnabled()) return null;
  const g = await getGoldenSampleForOrder(actor, orderId).catch(() => null);
  if (!g) return null;
  const l = await sampleLabels(locale);
  return (
    <section aria-labelledby="golden-sample">
      <Card>
        <CardBody className="flex flex-col gap-3">
          <CardTitle id="golden-sample" className="text-lg">{l.goldenTitle}</CardTitle>
          <p className="text-sm text-muted">{fill(l.goldenIntro, { date: formatDate(new Date(g.approvedAt), locale, { dateStyle: "medium" }) })}</p>
          <p className="text-sm font-medium text-ink">{g.subject}</p>
          {g.notes ? <p className="text-sm text-ink">{g.notes}</p> : null}
          {g.photos.length ? (
            <ul className="flex flex-wrap gap-2">
              {g.photos.map((p, i) => (
                <li key={p.id}>
                  <Image unoptimized src={`/buyer/samples/${g.id}/photos/${p.id}`} alt={fill(l.photoAlt, { n: i + 1 })} width={96} height={96} className="size-24 rounded-md border border-line object-cover" />
                </li>
              ))}
            </ul>
          ) : null}
          <Link href={`/buyer/samples/${g.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{l.viewSample}</Link>
        </CardBody>
      </Card>
    </section>
  );
}
