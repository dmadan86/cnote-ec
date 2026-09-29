"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Button, Input } from "@cnote/ui";
import { useActionState } from "react";
import { reactAction } from "./actions";

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

/** "Helpful" (reviews only) and "Report" (with a short reason). Signed-out clicks get an inline prompt from the action. */
export function ReactionButtons({ listingId, subjectType, subjectId, helpfulCount }: { listingId: string; subjectType: "review" | "comment"; subjectId: string; helpfulCount?: number }) {
  const [helpful, helpfulAction, helpfulPending] = useActionState<State, FormData>(reactAction, null);
  const [report, reportAction, reportPending] = useActionState<State, FormData>(reactAction, null);
  const voted = helpful?.ok === true;
  const reported = report?.ok === true;
  const problem = (helpful && !helpful.ok ? helpful.error : null) ?? (report && !report.ok ? (report.fieldErrors?.reason ?? report.error) : null);
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2 text-sm">
      {subjectType === "review" ? (
        <form action={helpfulAction}>
          <Hidden listingId={listingId} subjectType={subjectType} subjectId={subjectId} kind="helpful" />
          <Button type="submit" size="sm" variant="outline" disabled={helpfulPending || voted} aria-pressed={voted}>
            {voted ? "Marked helpful" : "Helpful"}{helpfulCount ? ` (${helpfulCount + (voted ? 1 : 0)})` : ""}
          </Button>
        </form>
      ) : null}
      {reported ? (
        <p role="status" className="text-muted">Thanks, we&apos;ll take a look.</p>
      ) : (
        <details className="group">
          <summary className="cursor-pointer list-none rounded px-1 py-1.5 text-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-2 focus-visible:outline-brand-600">Report</summary>
          <form action={reportAction} className="mt-2 flex flex-col gap-2 sm:flex-row">
            <Hidden listingId={listingId} subjectType={subjectType} subjectId={subjectId} kind="report" />
            <label htmlFor={`rp-${subjectId}`} className="sr-only">Why are you reporting this?</label>
            <Input id={`rp-${subjectId}`} name="reason" required minLength={3} maxLength={300} placeholder="What's wrong with it?" className="sm:w-64" />
            <Button type="submit" size="sm" variant="outline" disabled={reportPending}>Send report</Button>
          </form>
        </details>
      )}
      {problem ? <p role="alert" className="basis-full text-xs text-danger">{problem}</p> : null}
    </div>
  );
}
