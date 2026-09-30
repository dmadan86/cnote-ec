import { disputesEnabled, getDisputeForOrder, type Actor } from "@/lib/disputes";
import { Card, CardBody, CardTitle } from "@cnote/ui";
import Link from "next/link";
import { ReportForm } from "./forms";
import { disputeLabels } from "./labels";
import type { Locale } from "@/i18n/config";

const DISPUTABLE = ["confirmed", "dispatched", "delivered", "completed"];

/**
 * Mounted on the buyer order page. Renders nothing while DISPUTES_ENABLED is off. Existing dispute -> link to it;
 * otherwise a native disclosure (keyboard + screen-reader friendly, no JS needed to open) holding the report form.
 */
export async function ReportProblem({ orderId, status, actor, locale = "en" }: { orderId: string; status: string; actor: Actor; locale?: Locale }) {
  if (!disputesEnabled()) return null;
  const [existing, l] = await Promise.all([getDisputeForOrder(actor, orderId), disputeLabels(locale)]);
  const open = existing && !["resolved", "withdrawn"].includes(existing.status);
  if (existing && open) {
    return (
      <Card><CardBody className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{l.heading}</CardTitle>
        <Link href={`/buyer/disputes/${existing.id}`} className="inline-flex min-h-11 items-center font-medium text-brand-700 underline">{l.viewDispute}</Link>
      </CardBody></Card>
    );
  }
  if (!DISPUTABLE.includes(status)) return null;
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        {existing ? <Link href={`/buyer/disputes/${existing.id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{l.viewDispute}</Link> : null}
        <details className="group">
          <summary className="inline-flex min-h-11 cursor-pointer items-center font-semibold text-ink focus-visible:outline-2 focus-visible:outline-brand-600">{l.reportProblem}</summary>
          <div className="mt-3 flex flex-col gap-3">
            <p className="text-sm text-muted">{l.reportIntro}</p>
            <ReportForm orderId={orderId} labels={l} />
            <Link href="/dispute-policy" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{l.policyLink}</Link>
          </div>
        </details>
      </CardBody>
    </Card>
  );
}
