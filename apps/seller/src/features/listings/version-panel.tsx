"use client";
import { useActionState, useEffect, useRef } from "react";
import { Eye, Undo2 } from "lucide-react";
import { Alert, Badge, Card, CardBody, Field, Input, Textarea, buttonClasses } from "@cnote/ui";
import type { VersionOverview, VersionView } from "@cnote/catalogue";
import { SubmitButton } from "@/features/shell/form-bits";
import { submitVersionAction, unpublishListingAction, withdrawVersionAction, type VersionActionResult } from "./actions";
import { VERSION_STATUS, versionSummary } from "./version-utils";

export type PanelVersion = VersionView & { previewUrl: string };
export type PanelOverview = Pick<VersionOverview, "live" | "pending" | "unsubmittedChanges"> & { listingId: string; versions: PanelVersion[] };

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
const val = (v: string | number | null) => (v === null || v === "" ? "empty" : String(v));

function Msg({ state }: { state: VersionActionResult | null }) {
  if (!state) return null;
  return state.ok ? <Alert tone="success">{state.data.message}</Alert> : <Alert tone="danger">{state.error}</Alert>;
}

function Withdraw({ versionId }: { versionId: string }) {
  const [state, action] = useActionState<VersionActionResult | null, FormData>(withdrawVersionAction, null);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="versionId" value={versionId} />
      <SubmitButton size="sm" variant="outline" pendingText="Withdrawing…"><Undo2 className="mr-1 size-3.5" aria-hidden /> Withdraw</SubmitButton>
      {state && !state.ok ? <span className="ml-2 text-xs text-danger">{state.error}</span> : null}
    </form>
  );
}

function SubmitForm({ listingId, disabledReason }: { listingId: string; disabledReason: string | null }) {
  const [state, action] = useActionState<VersionActionResult | null, FormData>(submitVersionAction, null);
  const tz = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (tz.current) tz.current.value = String(new Date().getTimezoneOffset());
  }, []);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="listingId" value={listingId} />
      <input type="hidden" name="tzOffset" ref={tz} defaultValue="0" />
      <Field label="What changed? (optional)" htmlFor="changeNote" hint="Shown to our reviewers and in your history.">
        <Textarea id="changeNote" name="changeNote" maxLength={500} className="min-h-16" placeholder="e.g. Updated price and added 3-ply option" />
      </Field>
      <Field label="Go live at (optional)" htmlFor="publishAt" hint="Leave empty to go live as soon as it is approved.">
        <Input id="publishAt" name="publishAt" type="datetime-local" className="h-11 max-w-xs" />
      </Field>
      <Msg state={state} />
      <SubmitButton size="lg" pendingText="Submitting…" disabled={!!disabledReason}>Submit for review</SubmitButton>
      {disabledReason ? <p className="text-xs text-muted">{disabledReason}</p> : null}
    </form>
  );
}

function Unpublish({ listingId }: { listingId: string }) {
  const [state, action] = useActionState<VersionActionResult | null, FormData>(unpublishListingAction, null);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="id" value={listingId} />
      <SubmitButton variant="outline" size="sm" pendingText="Taking offline…">Take offline</SubmitButton>
      <Msg state={state} />
    </form>
  );
}

export function VersionPanel({ overview }: { overview: PanelOverview }) {
  const { live, pending, unsubmittedChanges, versions, listingId } = overview;
  const hasChanges = unsubmittedChanges.length > 0;
  const disabledReason = pending && !hasChanges ? "Your latest version is already waiting. Edit and save the listing to submit a newer one." : !hasChanges && live ? "No changes since the live version." : null;
  return (
    <Card>
      <CardBody className="space-y-5">
        <div>
          <h2 className="font-semibold text-ink">Versions and publishing</h2>
          <p className="mt-1 text-sm font-medium text-ink" data-testid="version-summary">{versionSummary(overview)}</p>
          <p className="mt-1 text-sm text-muted">Buyers only ever see the live version. Saving edits changes your working copy; submit it for review to publish it.</p>
        </div>

        {hasChanges ? (
          <div className="rounded-card border border-line bg-surface p-3 text-sm">
            <p className="font-medium text-ink">Unsubmitted changes ({unsubmittedChanges.length})</p>
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
          <h3 className="text-sm font-semibold text-ink">History</h3>
          {versions.length === 0 ? <p className="mt-1 text-sm text-muted">No versions yet. Submit your first one above.</p> : null}
          <ol className="mt-2 space-y-3 border-l border-line pl-4">
            {versions.map((v) => {
              const st = VERSION_STATUS[v.status];
              return (
                <li key={v.id} className="relative space-y-1.5">
                  <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full bg-brand" aria-hidden />
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">Version {v.version}</span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <span className="text-xs text-muted">{when(v.createdAt)}</span>
                  </div>
                  {v.changeNote ? <p className="text-sm text-ink">{v.changeNote}</p> : null}
                  {v.publishAt && v.status !== "published" && v.status !== "superseded" ? <p className="text-xs text-muted">Scheduled for {when(v.publishAt)}</p> : null}
                  {v.publishedAt ? <p className="text-xs text-muted">Went live {when(v.publishedAt)}</p> : null}
                  {v.reviewNote ? <p className={`text-sm ${v.status === "rejected" ? "text-danger" : "text-muted"}`}>Reviewer: {v.reviewNote}</p> : null}
                  {v.changes.length ? (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted">{v.changes.length} change{v.changes.length === 1 ? "" : "s"}</summary>
                      <ul className="mt-1 space-y-0.5 text-muted">
                        {v.changes.map((c) => (
                          <li key={c.field}><span className="text-ink">{c.label}</span>: {val(c.before)} → {val(c.after)}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <a href={v.previewUrl} target="_blank" rel="noreferrer" className={buttonClasses("outline", "sm")}><Eye className="mr-1 size-3.5" aria-hidden /> Preview</a>
                    {v.status === "submitted" || v.status === "in_review" || v.status === "approved" ? <Withdraw versionId={v.id} /> : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="mt-2 text-xs text-muted">Preview links open the buyer page with a &quot;not live&quot; banner and expire after an hour; reload this page for a fresh link.</p>
        </div>
      </CardBody>
    </Card>
  );
}
