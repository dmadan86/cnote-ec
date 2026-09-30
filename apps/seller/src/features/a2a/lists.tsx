import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Card, CardBody, Money } from "@cnote/ui";
import type { MandateView, NegotiationSummary } from "@cnote/a2a";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { MandateStatusBadge, NegotiationStatusBadge } from "./badges";

export function MandateList({ items }: { items: MandateView[] }) {
  const t = useTranslations("a2a");
  return (
    <ul className="grid gap-3">
      {items.map((m) => (
        <li key={m.id}>
          <Link href={`/agents/mandates/${m.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
            <Card className="transition-colors hover:border-brand-600">
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{m.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{m.autoAccept ? t("auto.on") : t("auto.off")} · {t("mandate.version", { n: m.version })}</p>
                </div>
                <MandateStatusBadge status={m.status} />
              </CardBody>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function NegotiationList({ items, empty }: { items: NegotiationSummary[]; empty: string }) {
  const t = useTranslations("a2a");
  const loc = useLocale();
  const locale = isLocale(loc) ? loc : "en";
  if (items.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul className="grid gap-3">
      {items.map((n) => (
        <li key={n.id}>
          <Link href={`/agents/negotiations/${n.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
            <Card className="transition-colors hover:border-brand-600">
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{n.counterparty.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{t("negotiation.round", { n: n.round, max: n.maxRounds })} · {formatDate(n.createdAt, locale)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {n.agreedPricePaise !== null ? <Money paise={n.agreedPricePaise} /> : n.lastPricePaise !== null ? <Money paise={n.lastPricePaise} /> : null}
                  <NegotiationStatusBadge status={n.status} />
                </div>
              </CardBody>
            </Card>
          </Link>
        </li>
      ))}
    </ul>
  );
}
