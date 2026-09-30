"use client";
import { useActionState, useEffect, useRef } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Eye, Undo2 } from "lucide-react";
import { Alert, Badge, Card, CardBody, Field, Input, Textarea, buttonClasses } from "@cnote/ui";
import type { VersionOverview, VersionView } from "@cnote/catalogue";
import { SubmitButton } from "@/features/shell/form-bits";
import { submitVersionAction, unpublishListingAction, withdrawVersionAction, type VersionActionResult } from "./actions";
import { VERSION_STATUS, versionSummary } from "./version-utils";
import { intlTag } from "@/i18n/config";

export type PanelVersion = VersionView & { previewUrl: string };
export type PanelOverview = Pick<VersionOverview, "live" | "pending" | "unsubmittedChanges"> & { listingId: string; versions: PanelVersion[] };

const useWhen = () => {
  const locale = useLocale();
  return (iso: string) => new Date(iso).toLocaleString(intlTag(locale), { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
};

function Msg({ state }: { state: VersionActionResult | null }) {
  if (!state) return null;
  return state.ok ? <Alert tone="success">{state.data.message}</Alert> : <Alert tone="danger">{state.error}</Alert>;
}

function Withdraw({ versionId }: { versionId: string }) {
  const t = useTranslations("listings.versions");
  const [state, action] = useActionState<VersionActionResult | null, FormData>(withdrawVersionAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="versionId" value={versionId} />
      <SubmitButton size="sm" variant="outline" pendingText={t("withdrawing")}><Undo2 className="mr-1 size-3.5" aria-hidden /> {t("withdraw")}</SubmitButton>
      {state && !state.ok ? <span className="ml-2 text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}

function SubmitForm({ listingId, disabledReason }: { listingId: string; disabledReason: string | null }) {
  const t = useTranslations("listings.versions");
  const [state, action] = useActionState<VersionActionResult | null, FormData>(submitVersionAction, null);
  const tz = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (tz.current) tz.current.value = String(new Date().getTimezoneOffset());
  }, []);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="tzOffset" ref={tz} defaultValue="0" />
      <Field label={t("changeNote")} htmlFor="changeNote" hint={t("changeNoteHint")}>
        <Textarea id="changeNote" name="changeNote" maxLength={500} className="min-h-16" placeholder={t("changeNotePlaceholder")} />
      </Field>
      <Field label={t("publishAt")} htmlFor="publishAt" hint={t("publishAtHint")}>
        <Input id="publishAt" name="publishAt" type="datetime-local" className="h-11 max-w-xs" />
      </Field>
      <Msg state={state} />
      <SubmitButton size="lg" pendingText={t("submitting")} disabled={!!disabledReason}>{t("submit")}</SubmitButton>
      {disabledReason ? <p className="text-xs text-muted">{disabledReason}</p> : null}
    </form>
  );
}

function Unpublish({ listingId }: { listingId: string }) {
  const t = useTranslations("listings.versions");
  const [state, action] = useActionState<VersionActionResult | null, FormData>(unpublishListingAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={listingId} />
      <SubmitButton variant="outline" size="sm" pendingText={t("takingOffline")}>{t("takeOffline")}</SubmitButton>
      <Msg state={state} />
    </form>
  );
}

export function VersionPanel({ overview }: { overview: PanelOverview }) {
  const t = useTranslations("listings.versions");
  const tl = useTranslations("listings");
  const when = useWhen();
  const val = (v: string | number | null) => (v === null || v === "" ? t("empty") : String(v));
  const { live, pending, unsubmittedChanges, versions, listingId } = overview;
  const hasChanges = unsubmittedChanges.length > 0;
  const disabledReason = pending && !hasChanges ? t("waiting") : !hasChanges && live ? t("noChanges") : null;
  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h2 className="font-semibold text-ink">{t("title")}</h2>
          <p className="mt-1 text-sm font-medium text-ink" data-testid="version-summary">{versionSummary(overview, tl)}</p>
          <p className="mt-1 text-sm text-muted">{t("intro")}</p>
        </div>

        {hasChanges ? (
          <div className="rounded-card border border-line bg-surface p-3 text-sm">
            <p className="font-medium text-ink">{t("unsubmitted", { count: unsubmittedChanges.length })}</p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {unsubmittedChanges.slice(0, 8).map((c) => (
                <li key={c.field}><span className="text-ink">{c.label}</span>: {val(c.before)} → {val(c.after)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <SubmitForm listingId={listingId} disabledReason={disabledReason} />
        {live ? <Unpublish listingId={listingId} /> : null}

        <div>
          <h3 className="text-sm font-semibold text-ink">{t("history")}</h3>
          {versions.length === 0 ? <p className="mt-1 text-sm text-muted">{t("noVersions")}</p> : null}
          <ol className="mt-2 space-y-3 border-l border-line pl-4">
            {versions.map((v) => {
              const st = VERSION_STATUS[v.status];
              return (
                <li key={v.id} className="relative space-y-1.5">
                  <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-brand" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{t("version", { version: v.version })}</span>
                    <Badge tone={st.tone}>{tl(`versionStatus.${v.status}`)}</Badge>
                    <span className="text-xs text-muted">{when(v.createdAt)}</span>
                  </div>
                  {v.changeNote ? <p className="text-sm text-ink">{v.changeNote}</p> : null}
                  {v.publishAt && v.status !== "published" && v.status !== "superseded" ? <p className="text-xs text-muted">{t("scheduledFor", { when: when(v.publishAt) })}</p> : null}
                  {v.publishedAt ? <p className="text-xs text-muted">{t("wentLive", { when: when(v.publishedAt) })}</p> : null}
                  {v.reviewNote ? <p className={`text-sm ${v.status === "rejected" ? "text-danger" : "text-muted"}`}>{t("reviewer", { note: v.reviewNote })}</p> : null}
                  {v.changes.length ? (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted">{t("changeCount", { count: v.changes.length })}</summary>
                      <ul className="mt-1 space-y-0.5 text-muted">
                        {v.changes.map((c) => (
                          <li key={c.field}><span className="text-ink">{c.label}</span>: {val(c.before)} → {val(c.after)}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={v.previewUrl} target="_blank" rel="noreferrer" className={buttonClasses("outline", "sm")}><Eye className="mr-1 size-3.5" aria-hidden /> {t("preview")}</a>
                    {v.status === "submitted" || v.status === "in_review" || v.status === "approved" ? <Withdraw versionId={v.id} /> : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-muted">{t("previewNote")}</p>
        </div>
      </CardBody>
    </Card>
  );
}
