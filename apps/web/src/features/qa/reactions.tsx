"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Button, Input } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { reactAction } from "@/features/reviews/actions";

type State = ActionResult<{ changed: boolean }> | null;

function Hidden({ listingId, subjectType, subjectId, kind }: { listingId: string; subjectType: string; subjectId: string; kind: string }) {
  return (
    <>
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="subjectType" value={subjectType} />
      <input type="hidden" name="subjectId" value={subjectId} />
      <input type="hidden" name="kind" value={kind} />
    </>
  );
}

/** "Helpful" vote and "Report" for one public answer; same server action and dedupe as review reactions. */
export function QaReactions({ listingId, answerId, questionId, helpfulCount }: { listingId: string; answerId: string; questionId: string; helpfulCount: number }) {
  const t = useTranslations("qa");
  const [helpful, helpfulAction, helpfulPending] = useActionState<State, FormData>(reactAction, null);
  const [report, reportAction, reportPending] = useActionState<State, FormData>(reactAction, null);
  const voted = helpful?.ok === true;
  const reported = report?.ok === true;
  const problem = (helpful && !helpful.ok ? helpful.error : null) ?? (report && !report.ok ? (report.fieldErrors?.reason ?? report.error) : null);
  const total = helpfulCount + (voted ? 1 : 0);
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 text-sm">
      <form action={helpfulAction}>
        <Hidden listingId={listingId} subjectType="answer" subjectId={answerId} kind="helpful" />
        <Button type="submit" size="sm" variant="outline" disabled={helpfulPending || voted} aria-pressed={voted}>
          {voted ? t("markedHelpful") : t("helpful")}{total ? ` (${total})` : ""}
        </Button>
      </form>
      {reported ? (
        <p role="status" className="py-2 text-muted">{t("reportThanks")}</p>
      ) : (
        <details>
          <summary className="flex min-h-11 cursor-pointer list-none items-center rounded px-1 text-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-brand-600 sm:min-h-6">{t("report")}</summary>
          <form action={reportAction} className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Hidden listingId={listingId} subjectType="answer" subjectId={answerId} kind="report" />
            <label htmlFor={`qr-${questionId}`} className="sr-only">{t("reportReason")}</label>
            <Input id={`qr-${questionId}`} name="reason" required minLength={3} maxLength={300} placeholder={t("reportPlaceholder")} className="sm:w-64" />
            <Button type="submit" size="sm" variant="outline" disabled={reportPending}>{t("reportSend")}</Button>
          </form>
        </details>
      )}
      {problem ? <p role="alert" className="basis-full text-xs text-danger">{problem}</p> : null}
    </div>
  );
}
