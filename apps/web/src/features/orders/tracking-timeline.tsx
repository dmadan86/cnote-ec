import { Check, Circle, CircleDot } from "lucide-react";
import { Card, CardBody, CardTitle } from "@cnote/ui";
import { listFulfilmentEvents, trackingSteps, type OrderView } from "@cnote/enquiry";
import { getTranslations } from "next-intl/server";

const ICON = { done: Check, current: CircleDot, upcoming: Circle } as const;
const dt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });

/**
 * Buyer-facing delivery tracking (WCAG 2.2 AA): a labelled section, an ordered list whose done / current / not-yet state is
 * written out (icon is decorative, never colour alone) with aria-current on the current step, and the update history as a
 * second ordered list. Hidden for cancelled or not-yet-confirmed orders.
 */
export async function TrackingTimeline({ actor, order }: { actor: { personId: string; businessId: string }; order: OrderView }) {
  if (order.status === "cancelled" || order.status === "recorded") return null;
  const [t, all] = await Promise.all([getTranslations({ locale: "en", namespace: "orderTracking" }), listFulfilmentEvents(actor, order.id)]);
  const events = all.slice().reverse();
  const steps = trackingSteps(order);
  const tracking = order.trackingCourier && order.trackingRef ? t("trackingBoth", { courier: order.trackingCourier, ref: order.trackingRef })
    : order.trackingCourier ? t("trackingCourier", { courier: order.trackingCourier }) : order.trackingRef ? t("trackingRef", { ref: order.trackingRef }) : null;
  return (
    <section aria-labelledby="tracking-heading">
      <Card>
        <CardBody className="flex flex-col gap-4">
          <CardTitle id="tracking-heading" className="text-lg">{t("heading")}</CardTitle>
          <p className="text-sm text-muted">{t("intro")}</p>
          <ol aria-label={t("stepsLabel")} className="grid gap-3 sm:grid-cols-5">
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
              <ol className="mt-2 flex flex-col gap-2">
                {events.map((e) => (
                  <li key={e.id} className="rounded-md border border-line p-2 text-sm">
                    <p className="font-medium text-ink">{t(`stage.${e.stage}`)} <span className="font-normal text-muted">· <time dateTime={e.createdAt}>{dt.format(new Date(e.createdAt))}</time></span></p>
                    {e.note ? <p className="text-ink">{e.note}</p> : null}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </CardBody>
      </Card>
    </section>
  );
}
