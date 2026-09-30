import { Badge, Card, CardBody, Money, type BadgeTone } from "@cnote/ui";
import type { CompetitivenessItem, Position, Trend } from "@cnote/prices";
import { getTranslations } from "next-intl/server";

const POS: Record<Position, { tone: BadgeTone; glyph: string; key: "positionBelow" | "positionWithin" | "positionAbove" | "positionNoData" }> = {
  below: { tone: "brand", glyph: "↓", key: "positionBelow" },
  within: { tone: "success", glyph: "=", key: "positionWithin" },
  above: { tone: "warning", glyph: "↑", key: "positionAbove" },
  no_data: { tone: "neutral", glyph: "–", key: "positionNoData" },
};
const TREND: Record<Trend, { glyph: string; key: "trendUp" | "trendDown" | "trendFlat" | "trendUnknown" }> = {
  up: { glyph: "▲", key: "trendUp" }, down: { glyph: "▼", key: "trendDown" }, flat: { glyph: "▬", key: "trendFlat" }, unknown: { glyph: "", key: "trendUnknown" },
};

/**
 * Where each live listing's price sits against the benchmark band (ADR-022). Position and trend are always spelled out
 * in words next to the glyph, never by colour alone. Only aggregates are shown.
 */
export async function CompetitivenessTable({ items }: { items: CompetitivenessItem[] }) {
  const t = await getTranslations("prices");
  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("tableCaption")}</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="py-2 pr-3 font-medium">{t("colListing")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("colYourPrice")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("colBand")}</th>
                <th scope="col" className="py-2 pr-3 font-medium">{t("colPosition")}</th>
                <th scope="col" className="py-2 font-medium">{t("colTrend")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const pos = POS[i.position];
                const tr = TREND[i.trend];
                const pct = i.vsMedianBps === null ? null : Math.abs(Math.round(i.vsMedianBps / 100));
                return (
                  <tr key={i.listingId} className="border-b border-line align-top last:border-0">
                    <th scope="row" className="py-3 pr-3 font-medium text-ink">{i.title}<span className="block text-xs font-normal text-muted">{i.categoryName}</span></th>
                    <td className="py-3 pr-3"><Money paise={i.pricePaise} /> <span className="text-xs text-muted">{t("per", { unit: i.priceUnit })}</span></td>
                    <td className="py-3 pr-3">
                      {i.band ? (
                        <>
                          <span>{t("bandValue", { low: rupees(i.band.p25Paise), high: rupees(i.band.p75Paise), median: rupees(i.band.medianPaise) })}</span>
                          <span className="block text-xs text-muted">{t("bandScope", { region: i.band.regionLabel, period: i.band.period })}{i.band.rolledUp ? ` · ${t("widerArea")}` : ""}</span>
                        </>
                      ) : <span className="text-muted">{t("positionNoData")}</span>}
                    </td>
                    <td className="py-3 pr-3">
                      <Badge tone={pos.tone}><span aria-hidden="true">{pos.glyph} </span>{t(pos.key)}</Badge>
                      {pct !== null ? <span className="mt-1 block text-xs text-muted">{pct === 0 ? t("vsMedianEqual") : t(i.vsMedianBps! > 0 ? "vsMedianAbove" : "vsMedianBelow", { percent: pct })}</span> : null}
                    </td>
                    <td className="py-3">{tr.glyph ? <span aria-hidden="true">{tr.glyph} </span> : null}{t(tr.key)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">{t("basis")}</p>
      </CardBody>
    </Card>
  );
}

const rupees = (paise: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: paise % 100 === 0 ? 0 : 2 }).format(paise / 100);
