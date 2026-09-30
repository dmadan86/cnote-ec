import { getTranslations } from "next-intl/server";
import { useLocale, useTranslations } from "next-intl";
import { Camera, CircleHelp, CircleCheck, TriangleAlert } from "lucide-react";
import { Badge, Card, CardBody, CardHeader, CardTitle } from "@cnote/ui";
import { getSubmissionContext, listSellerChecks, type CheckResultView, type QualityActor, type QualityCheckView } from "@cnote/quality";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { PhotoUpload, PendingRefresh } from "./photo-upload";

const RESULT = {
  consistent: { tone: "success" as const, Icon: CircleCheck },
  inconsistent: { tone: "warning" as const, Icon: TriangleAlert },
  inconclusive: { tone: "neutral" as const, Icon: CircleHelp },
};

function ResultRow({ r }: { r: CheckResultView }) {
  const t = useTranslations("quality");
  const { tone, Icon } = RESULT[r.result];
  return (
    <li className="flex flex-wrap items-start gap-2 text-sm">
      <span className="min-w-40 font-medium text-ink">{t(`check.${r.check}`)}</span>
      <Badge tone={tone}><Icon className="mr-1 inline size-3.5" aria-hidden />{t(`result.${r.result}`)}</Badge>
      {r.note ? <span className="text-muted">{r.note}</span> : null}
    </li>
  );
}

function CheckCard({ c }: { c: QualityCheckView }) {
  const t = useTranslations("quality");
  const loc = useLocale();
  const locale = isLocale(loc) ? loc : "en";
  return (
    <li className="space-y-2 rounded-md border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("sharedLabel", { when: formatDateTime(c.createdAt, locale), count: c.mediaIds.length })}</p>
        <Badge tone={c.status === "completed" ? "success" : c.status === "failed" ? "danger" : "neutral"}>
          {c.status === "completed" ? t("analysed") : c.status === "failed" ? t("failed") : t("analysing")}
        </Badge>
      </div>
      {c.mediaIds.length ? (
        <ul className="flex flex-wrap gap-2" aria-label={t("sharedPhotos")}>
          {c.mediaIds.map((id, i) => (
            <li key={id}>
              {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated route */}
              <img src={`/api/quality/media/${id}`} alt={t("dispatchPhoto", { n: i + 1 })} className="size-20 rounded-md border border-line object-cover" loading="lazy" />
            </li>
          ))}
        </ul>
      ) : null}
      {c.status === "completed" ? <ul className="space-y-1.5">{c.results.map((r) => <ResultRow key={r.check} r={r} />)}</ul> : null}
    </li>
  );
}

/** ADR-015 pilot: pre-dispatch photos with an order-derived checklist. Advisory only; renders nothing when the feature is off for this order. */
export async function DispatchPhotosPanel({ actor, orderId }: { actor: QualityActor; orderId: string }) {
  const t = await getTranslations("quality");
  let ctx, checks: QualityCheckView[] = [];
  try {
    ctx = await getSubmissionContext(actor, orderId);
    if (ctx.reason === "disabled" || ctx.reason === "not_found" || ctx.reason === "not_seller" || ctx.reason === "no_category" || ctx.reason === "category_not_enabled") return null;
    checks = await listSellerChecks(actor.businessId, orderId);
  } catch (err) {
    console.error("[seller] dispatch photos panel failed", err);
    return null; // optional feature: never break the order page
  }
  const busy = checks.some((c) => c.status === "pending" || c.status === "analysing");
  return (
    <Card>
      <CardHeader><CardTitle><Camera className="mr-2 inline size-5" aria-hidden />{t("title")}</CardTitle></CardHeader>
      <CardBody className="space-y-4">
        <p className="text-sm text-muted">
          {t("intro")}
        </p>
        <div>
          <h3 className="text-sm font-semibold">{t("checklist")}</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
            {ctx.checklist.map((i) => <li key={i.check}><span className="font-medium">{i.label}.</span> <span className="text-muted">{i.expected}</span></li>)}
          </ul>
        </div>
        {ctx.eligible ? <PhotoUpload orderId={orderId} maxPhotos={ctx.maxPhotos} /> : <p className="text-sm text-muted" role="status">{ctx.reason === "limit_reached" ? t("limitReached") : t("onlyBeforeDispatch")}</p>}
        {busy ? <PendingRefresh /> : null}
        {checks.length ? <ul className="space-y-3">{checks.map((c) => <CheckCard key={c.id} c={c} />)}</ul> : null}
      </CardBody>
    </Card>
  );
}
