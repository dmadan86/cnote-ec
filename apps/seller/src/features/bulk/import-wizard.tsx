"use client";
import { useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, FileSpreadsheet, FileArchive, UploadCloud } from "lucide-react";
import { Alert, Button, Card, CardBody, Select } from "@cnote/ui";
import type { BulkJobView } from "@cnote/bulk";
import { cancelJobAction, confirmImportAction } from "./actions";
import { JobBadge, useFmtDate } from "./job-status";
import { useJob } from "./use-job";
import { intlTag } from "@/i18n/config";

const MAX_BYTES = 200 * 1024 * 1024;
const ACCEPT = ".csv,.xlsx,.zip";

function upload(file: File, mode: string, submit: boolean, onProgress: (p: number) => void, msgs: { network: string; failed: string }): Promise<{ job?: BulkJobView; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/bulk/imports?filename=${encodeURIComponent(file.name)}&mode=${mode}&submit=${submit ? 1 : 0}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => resolve({ error: msgs.network });
    xhr.onload = () => {
      let body: { job?: BulkJobView; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      resolve(xhr.status >= 200 && xhr.status < 300 && body.job ? { job: body.job } : { error: body.error && body.error !== "internal" ? body.error : msgs.failed });
    };
    xhr.send(file); // raw body: streamed to the server, no multipart buffering
  });
}

export function ImportWizard({ categories, recent }: { categories: { slug: string; name: string }[]; recent: BulkJobView[] }) {
  const t = useTranslations("listings.bulk.import");
  const fmtDate = useFmtDate();
  const locale = useLocale();
  const [mode, setMode] = useState<"upsert" | "create">("upsert");
  const [submit, setSubmit] = useState(false);
  const [category, setCategory] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [job, setJob] = useJob(null);
  const [pending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const cat = category ? `&category=${encodeURIComponent(category)}` : "";

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (!/\.(csv|xlsx|zip)$/i.test(file.name)) return setError(t("badType"));
    if (file.size > MAX_BYTES) return setError(t("tooLarge"));
    setProgress(0);
    const r = await upload(file, mode, submit, setProgress, { network: t("network"), failed: t("uploadFailed") });
    setProgress(null);
    if (r.job) setJob(r.job);
    else setError(r.error ?? t("uploadFailed"));
  }

  function confirm(skipInvalid: boolean) {
    if (!job) return;
    setError(null);
    startTransition(async () => {
      const r = await confirmImportAction(job.id, skipInvalid);
      if (r.ok) setJob(r.data);
      else setError(r.error);
    });
  }
  function cancel() {
    if (!job) return;
    startTransition(async () => {
      const r = await cancelJobAction(job.id);
      if (r.ok) setJob(r.data);
      else setError(r.error);
    });
  }
  const reset = () => {
    setJob(null);
    setError(null);
  };

  const validRows = job ? job.totalRows - job.errorCount : 0;
  const warnings = job?.options && "warnings" in job.options ? ((job.options as { warnings?: string[] }).warnings ?? []) : [];

  return (
    <div className="space-y-6">
      {!job ? (
        <>
          <Card>
            <CardBody className="space-y-4">
              <div>
                <h2 className="text-base font-semibold text-ink">{t("step1")}</h2>
                <p className="mt-1 text-sm text-muted">
                  {t("step1Body")}
                </p>
              </div>
              <div className="max-w-sm">
                <label htmlFor="tpl-cat" className="text-sm font-medium text-ink">{t("attrFor")}</label>
                <Select id="tpl-cat" value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 h-11">
                  <option value="">{t("allCategories")}</option>
                  {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-brand-600 bg-surface px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50" href={`/api/bulk/template?format=xlsx${cat}`}>
                  <FileSpreadsheet className="size-4" aria-hidden /> {t("tplExcel")}
                </a>
                <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas" href={`/api/bulk/template?format=csv${cat}`}>
                  <Download className="size-4" aria-hidden /> {t("tplCsv")}
                </a>
                <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas" href={`/api/bulk/template?format=kit${cat}`}>
                  <FileArchive className="size-4" aria-hidden /> {t("tplKit")}
                </a>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-4">
              <h2 className="text-base font-semibold text-ink">{t("step2")}</h2>
              <fieldset className="space-y-2">
                <legend className="sr-only">{t("modeLegend")}</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="mode" checked={mode === "upsert"} onChange={() => setMode("upsert")} className="mt-1 size-4" />
                  <span><b>{t("upsert")}</b> {t("upsertNote")}</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="mode" checked={mode === "create"} onChange={() => setMode("create")} className="mt-1 size-4" />
                  <span><b>{t("createOnly")}</b> {t("createOnlyNote")}</span>
                </label>
              </fieldset>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} className="mt-1 size-4" />
                <span><b>{t("submitAfter")}</b> {t("submitAfterNote")}</span>
              </label>
            </CardBody>
          </Card>

          <section aria-labelledby="up-h" className="space-y-3">
            <h2 id="up-h" className="text-base font-semibold text-ink">{t("step3")}</h2>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void pick(e.dataTransfer.files[0]); }}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center ${dragging ? "border-brand-600 bg-brand-50" : "border-line bg-surface"}`}
            >
              <UploadCloud className="size-7 text-muted" aria-hidden />
              <p className="text-sm text-muted">{t("drag")}</p>
              <Button variant="outline-brand" className="min-h-11" disabled={progress !== null} onClick={() => input.current?.click()}>{t("chooseFile")}</Button>
              <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label={t("chooseAria")} onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
              <p className="text-xs text-muted">{t("limits")}</p>
            </div>
            {progress !== null ? (
              <div aria-live="polite" className="rounded-lg border border-line bg-surface p-3 text-sm">
                <div className="flex justify-between"><span>{progress < 100 ? t("uploading") : t("checking")}</span><span className="text-muted">{progress}%</span></div>
                <progress className="mt-2 h-1.5 w-full" value={progress} max={100} aria-label={t("uploadProgress")} />
              </div>
            ) : null}
            {error ? <Alert tone="danger">{error}</Alert> : null}
          </section>
        </>
      ) : (
        <JobPanel job={job} validRows={validRows} warnings={warnings} pending={pending} error={error} onConfirm={confirm} onCancel={cancel} onReset={reset} />
      )}

      {!job && recent.length ? (
        <section aria-labelledby="recent-h" className="space-y-2">
          <h2 id="recent-h" className="text-base font-semibold text-ink">{t("recent")}</h2>
          <ul className="grid gap-2">
            {recent.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{j.originalName ?? t("importName")}</p>
                  <p className="text-muted">{t("recentLine", { date: fmtDate(j.createdAt), rows: j.totalRows.toLocaleString(intlTag(locale)), created: j.createdCount, updated: j.updatedCount })}{j.errorCount ? t("withErrors", { count: j.errorCount }) : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <JobBadge status={j.status} />
                  {j.hasErrorReport ? <a className="min-h-11 px-2 py-2 text-brand-700 underline" href={`/api/bulk/jobs/${j.id}/download?which=errors`}>{t("errorReport")}</a> : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function JobPanel({ job, validRows, warnings, pending, error, onConfirm, onCancel, onReset }: { job: BulkJobView; validRows: number; warnings: string[]; pending: boolean; error: string | null; onConfirm: (skip: boolean) => void; onCancel: () => void; onReset: () => void }) {
  const t = useTranslations("listings.bulk.import");
  const running = job.status === "queued" || job.status === "processing";
  const settled = ["completed", "completed_with_errors", "failed", "cancelled"].includes(job.status);
  const pct = job.totalRows ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100)) : 0;
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">{job.originalName}</h2>
            <p className="text-sm text-muted">{job.options.mode === "create" ? t("modeCreate") : t("modeUpsert")}{job.options.submitForReview ? t("submitForReview") : t("saveAsDrafts")}</p>
          </div>
          <JobBadge status={job.status} />
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}
        {job.lastError ? <Alert tone="danger">{job.lastError}</Alert> : null}

        {job.status === "uploaded" || job.status === "validating" ? (
          <p className="text-sm text-muted" aria-live="polite">{t("validating")}</p>
        ) : null}

        {job.status === "validated" ? (
          <>
            <dl className="grid grid-cols-3 gap-3 text-center">
              <Count label={t("rows")} value={job.totalRows} />
              <Count label={t("ready")} value={validRows} tone="success" />
              <Count label={t("errorsLabel")} value={job.errorCount} tone={job.errorCount ? "danger" : undefined} />
            </dl>
            {warnings.length ? <Alert tone="warning">{warnings.join(" ")}</Alert> : null}
            {job.errorCount > 0 ? <ErrorTable job={job} /> : <Alert tone="success">{t("noProblems")}</Alert>}
            <p className="text-sm text-muted">{t("draftsOnly")}</p>
            <div className="flex flex-wrap gap-2">
              {job.errorCount === 0 ? (
                <Button className="min-h-11" disabled={pending} onClick={() => onConfirm(false)}>{t("importN", { count: validRows })}</Button>
              ) : validRows > 0 ? (
                <Button className="min-h-11" variant="accent" disabled={pending} onClick={() => onConfirm(true)}>{t("importValidSkip", { valid: validRows, errors: job.errorCount })}</Button>
              ) : null}
              <Button variant="outline" className="min-h-11" disabled={pending} onClick={onCancel}>{t("cancelImport")}</Button>
            </div>
          </>
        ) : null}

        {running ? (
          <div aria-live="polite" className="space-y-2">
            <div className="flex justify-between text-sm"><span>{job.status === "queued" ? t("waitingWorker") : t("importedOf", { done: job.processedRows, total: job.totalRows })}</span><span className="text-muted">{pct}%</span></div>
            <progress className="h-2 w-full" value={pct} max={100} aria-label={t("importProgress")} />
            <p className="text-xs text-muted">{t("runningLine", { created: job.createdCount, updated: job.updatedCount, images: job.imageCount })}{job.errorCount ? t("runningErrors", { count: job.errorCount }) : ""}{t("runningLeave")}</p>
            <Button variant="outline" className="min-h-11" disabled={pending} onClick={onCancel}>{t("stop")}</Button>
          </div>
        ) : null}

        {settled ? (
          <>
            {job.status === "completed" || job.status === "completed_with_errors" ? (
              <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                <Count label={t("created")} value={job.createdCount} tone="success" />
                <Count label={t("updated")} value={job.updatedCount} />
                <Count label={t("photos")} value={job.imageCount} />
                <Count label={t("errorsLabel")} value={job.errorCount} tone={job.errorCount ? "danger" : undefined} />
              </dl>
            ) : null}
            {job.status === "cancelled" ? <p className="text-sm text-muted">{t("cancelledNote")}</p> : null}
            {job.errorCount > 0 ? <ErrorTable job={job} /> : null}
            {job.status === "completed" || job.status === "completed_with_errors" ? (
              <p className="text-sm text-muted">{t("doneBefore")}<a className="text-brand-700 underline" href="/listings">{t("doneLink")}</a>{job.options.submitForReview ? t("doneAfterReview") : t("doneAfterDrafts")}</p>
            ) : null}
          </>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {job.hasErrorReport ? <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas" href={`/api/bulk/jobs/${job.id}/download?which=errors`}><Download className="size-4" aria-hidden /> {t("downloadErrors")}</a> : null}
          {job.status !== "queued" && job.status !== "processing" && job.status !== "validating" ? <Button variant="ghost" className="min-h-11" onClick={onReset}>{t("another")}</Button> : null}
        </div>
      </CardBody>
    </Card>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  const locale = useLocale();
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <dd className={`text-xl font-semibold ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-ink"}`}>{value.toLocaleString(intlTag(locale))}</dd>
      <dt className="text-xs text-muted">{label}</dt>
    </div>
  );
}

function ErrorTable({ job }: { job: BulkJobView }) {
  const t = useTranslations("listings.bulk.import");
  const shown = job.sampleErrors;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-ink">{t("problemsTitle", { count: job.errorCount })}</h3>
      <div className="max-h-80 overflow-auto rounded-lg border border-line">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-canvas text-xs text-muted"><tr><th className="p-2">{t("colRow")}</th><th className="p-2">{t("colColumn")}</th><th className="p-2">{t("colProblem")}</th></tr></thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.row}-${e.column}-${i}`} className="border-t border-line align-top">
                <td className="p-2 tabular-nums">{e.row || t("fileRow")}</td>
                <td className="p-2 font-mono text-xs">{e.column || "-"}</td>
                <td className="p-2 text-danger">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">{t("showingFirst", { count: shown.length })}</p>
    </div>
  );
}
