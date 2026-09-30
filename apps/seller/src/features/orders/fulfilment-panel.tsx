import { getLocale, getTranslations } from "next-intl/server";
import { Check, Circle, CircleDot } from "lucide-react";
import { Card, CardBody, CardHeader, CardTitle } from "@cnote/ui";
import type { OrderView } from "@cnote/enquiry";
import { isLocale } from "@/i18n/config";
import { formatDateTime } from "@/lib/format";
import { enquiry } from "@/lib/services";
import { FulfilmentControls } from "./fulfilment-controls";

const ICON = { done: Check, current: CircleDot, upcoming: Circle } as const;

/**
 * Seller's delivery progress card: a step list (state stated in text, never colour alone), the update history with
 * courier/tracking details, and the controls for the next step. Cancelled orders show nothing.
 */
export async function FulfilmentPanel({ actor, order }: { actor: { personId: string; businessId: string }; order: OrderView }) {
  if (order.status === "cancelled" || order.status === "recorded") return null;
  const t = await getTranslations("orders.fulfilment");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  const events = (await enquiry.listFulfilmentEvents(actor, order.id)).slice().reverse();
  const steps = enquiry.trackingSteps(order);
  const stages = order.actions.fulfilment;
  const tracking = order.trackingCourier && order.trackingRef ? t("trackingBoth", { courier: order.trackingCourier, ref: order.trackingRef })
    : order.trackingCourier ? t("trackingCourier", { courier: order.trackingCourier }) : order.trackingRef ? t("trackingRef", { ref: order.trackingRef }) : null;
  return (
    <section aria-labelledby="fulfilment-heading">
      <Card>
        <CardHeader><CardTitle id="fulfilment-heading">{t("heading")}</CardTitle></CardHeader>
        <CardBody className="space-y-5">
          <p className="text-sm text-muted">{t("intro")}</p>
          <ol aria-label={t("stepsLabel")} className="grid gap-2 sm:grid-cols-5">
            {steps.map(({ step, state }) => {
              const Icon = ICON[state];
              return (
                <li key={step} aria-current={state === "current" ? "step" : undefined} className="flex items-start gap-2 text-sm">
                  <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span><span className="font-medium text-ink">{t(`step.${step}`)}</span><br /><span className="text-xs text-muted">{t(`state.${state}`)}</span></span>
                </li>
              );
            })}
          </ol>
          {tracking ? <p className="text-sm text-ink">{tracking}</p> : null}
          <div>
            <h3 className="text-sm font-semibold text-ink">{t("updates")}</h3>
            {events.length === 0 ? <p className="mt-1 text-sm text-muted">{t("noUpdates")}</p> : (
              <ol className="mt-2 space-y-2">
                {events.map((e) => (
                  <li key={e.id} className="rounded-md border border-line p-2 text-sm">
                    <p className="font-medium text-ink">{t(`stage.${e.stage}`)} <span className="font-normal text-muted">· {formatDateTime(e.createdAt, locale)}</span></p>
                    {e.note ? <p className="text-ink">{e.note}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <FulfilmentControls orderId={order.id} stages={stages} />
          {order.status === "confirmed" && order.actions.moves.includes("dispatched") ? <p className="text-sm text-muted">{t("needDispatch")}</p> : null}
        </CardBody>
      </Card>
    </section>
  );
}
