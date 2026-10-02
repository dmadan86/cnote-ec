"use client";
import type { MyQuestion } from "@cnote/reviews";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Badge, Textarea, buttonClasses } from "@cnote/ui";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import { SubmitButton } from "@/features/reviews/submit-button";
import { askQuestionAction, type AskResult } from "./actions";

interface ViewerState {
  signedIn: boolean;
  isSellerSide: boolean;
  mine: MyQuestion[];
}
const SIGNED_OUT: ViewerState = { signedIn: false, isSellerSide: false, mine: [] };

function MyQuestions({ items }: { items: MyQuestion[] }) {
  const t = useTranslations("qa");
  if (!items.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-ink">{t("mineTitle")}</h3>
      <ul className="space-y-2">
        {items.map((q) => (
          <li key={q.id} className="space-y-1 rounded-card border border-line bg-canvas p-3 text-sm">
            <p className="flex flex-wrap items-center gap-2">
              {q.status === "rejected" ? <Badge tone="danger">{t("statusRejected")}</Badge> : q.answer ? <Badge tone="success">{t("statusAnswered")}</Badge> : q.status === "pending" ? <Badge tone="warning">{t("statusReview")}</Badge> : <Badge tone="neutral">{t("statusAwaiting")}</Badge>}
            </p>
            <p className="whitespace-pre-wrap text-ink">{q.body}</p>
            {q.answer ? <p className="whitespace-pre-wrap border-l-2 border-brand-100 pl-3 text-ink"><span className="font-medium">{t("sellerAnswer")}: </span>{q.answer.body}</p> : null}
            {q.status === "rejected" && q.moderationNote ? <p className="text-xs text-danger">{t("rejectedReason", { note: q.moderationNote })}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Viewer-specific part of the Q&A section: own questions plus the ask form. Per-user, so a client island (never in cached HTML). */
export function QaAskPanel({ listingId }: { listingId: string }) {
  const t = useTranslations("qa");
  const [v, setV] = useState<ViewerState | null>(null);
  const [state, action] = useActionState<ActionResult<AskResult> | null, FormData>(askQuestionAction, null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/me/qa/${listingId}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<ViewerState>) : null))
      .then((d) => live && setV(d ?? SIGNED_OUT))
      .catch(() => live && setV(SIGNED_OUT));
    return () => {
      live = false;
    };
  }, [listingId, state]); // re-read own questions after each submission

  useEffect(() => {
    if (state?.ok) formRef.current?.reset();
  }, [state]);

  const signIn = `/signin?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname)}`;
  if (!v) return <div className="min-h-11" aria-hidden />;
  if (v.isSellerSide) return <Alert tone="info">{t("ownProduct")}</Alert>;
  if (!v.signedIn) {
    return (
      <Link href={signIn} className={buttonClasses("outline-brand", "md")}>
        {t("signIn")}
      </Link>
    );
  }
  const err = state && !state.ok ? (state.fieldErrors?.body ?? state.error) : undefined;
  return (
    <div className="space-y-4">
      <MyQuestions items={v.mine} />
      <form ref={formRef} action={action} noValidate className="space-y-2">
        <h3 className="text-base font-bold text-ink">{t("askTitle")}</h3>
        <input type="hidden" name="listingId" value={listingId} />
        <label htmlFor="qa-body" className="block text-sm font-medium text-ink">{t("askLabel")}</label>
        <Textarea
          id="qa-body"
          name="body"
          rows={3}
          maxLength={500}
          required
          aria-required="true"
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? "qa-hint qa-err" : "qa-hint"}
          placeholder={t("askPlaceholder")}
        />
        <p id="qa-hint" className="text-xs text-muted">{t("askHint")}</p>
        {err ? <p id="qa-err" role="alert" className="text-sm text-danger">{err}</p> : null}
        {state?.ok ? (
          <div role="status" className="space-y-1">
            <Alert tone="success">{state.data.status === "pending" ? t("sentHeld") : t("sentOk")}</Alert>
            {state.data.piiStripped ? <Alert tone="info">{t("sentStripped")}</Alert> : null}
          </div>
        ) : null}
        <SubmitButton pendingText={t("asking")} variant="outline-brand">{t("askBtn")}</SubmitButton>
      </form>
    </div>
  );
}
