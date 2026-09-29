"use client";
import { useRef, useState, useTransition } from "react";
import { Download, FileSpreadsheet, FileArchive, UploadCloud } from "lucide-react";
import { Alert, Button, Card, CardBody, Select } from "@cnote/ui";
import type { BulkJobView } from "@cnote/bulk";
import { cancelJobAction, confirmImportAction } from "./actions";
import { JobBadge, fmtDate } from "./job-status";
import { useJob } from "./use-job";

const MAX_BYTES = 200 * 1024 * 1024;
const ACCEPT = ".csv,.xlsx,.zip";

function upload(file: File, mode: string, submit: boolean, onProgress: (p: number) => void): Promise<{ job?: BulkJobView; error?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/bulk/imports?filename=${encodeURIComponent(file.name)}&mode=${mode}&submit=${submit ? 1 : 0}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onerror = () => resolve({ error: "Network problem. Please try again." });
    xhr.onload = () => {
      let body: { job?: BulkJobView; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {}
      resolve(xhr.status >= 200 && xhr.status < 300 && body.job ? { job: body.job } : { error: body.error && body.error !== "internal" ? body.error : "Upload failed. Please try again." });
    };
    xhr.send(file); // raw body: streamed to the server, no multipart buffering
  });
}

export function ImportWizard({ categories, recent }: { categories: { slug: string; name: string }[]; recent: BulkJobView[] }) {
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
    if (!/\.(csv|xlsx|zip)$/i.test(file.name)) return setError("Use a .csv, .xlsx or .zip file.");
    if (file.size > MAX_BYTES) return setError("The file is larger than 200 MB. Split it into parts.");
    setProgress(0);
    const r = await upload(file, mode, submit, setProgress);
    setProgress(null);
    if (r.job) setJob(r.job);
    else setError(r.error ?? "Upload failed");
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
                <h2 className="text-base font-semibold text-ink">1. Get a template</h2>
                <p className="mt-1 text-sm text-muted">
                  The templates come with dropdowns, hints and three example rows (marked EXAMPLE, skipped on import). The starter kit is a ZIP with the Excel and CSV templates, an example photo and a README, ready to add your own photos to.
                </p>
              </div>
              <div className="max-w-sm">
                <label htmlFor="tpl-cat" className="text-sm font-medium text-ink">Attribute columns for</label>
                <Select id="tpl-cat" value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 h-11">
                  <option value="">All categories</option>
                  {categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-brand-600 bg-surface px-4 text-sm font-semibold text-brand-700 hover:bg-brand-50" href={`/api/bulk/template?format=xlsx${cat}`}>
                  <FileSpreadsheet className="size-4" aria-hidden /> Download template (Excel)
                </a>
                <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas" href={`/api/bulk/template?format=csv${cat}`}>
                  <Download className="size-4" aria-hidden /> Download template (CSV)
                </a>
                <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink hover:bg-canvas" href={`/api/bulk/template?format=kit${cat}`}>
                  <FileArchive className="size-4" aria-hidden /> Download starter kit (ZIP with examples)
                </a>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardBody className="space-y-4">
              <h2 className="text-base font-semibold text-ink">2. Choose how to import</h2>
              <fieldset className="space-y-2">
                <legend className="sr-only">Import mode</legend>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="mode" checked={mode === "upsert"} onChange={() => setMode("upsert")} className="mt-1 size-4" />
                  <span><b>Create new and update existing</b> (matched by SKU). Empty cells on an existing product are left unchanged.</span>
                </label>
                <label className="flex items-start gap-2 text-sm">
                  <input type="radio" name="mode" checked={mode === "create"} onChange={() => setMode("create")} className="mt-1 size-4" />
                  <span><b>Create new only.</b> Rows whose SKU already exists are reported as errors.</span>
                </label>
              </fieldset>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} className="mt-1 size-4" />
                <span><b>Submit each product for review after importing.</b> Otherwise products stay as drafts you submit later. Nothing goes live without the usual checks and, where needed, staff review.</span>
              </label>
            </CardBody>
          </Card>

          <section aria-labelledby="up-h" className="space-y-3">
            <h2 id="up-h" className="text-base font-semibold text-ink">3. Upload your file</h2>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); void pick(e.dataTransfer.files[0]); }}
              className={`flex flex-col items-center gap-2 rounded-lg border-2 border-dashed p-8 text-center ${dragging ? "border-brand-600 bg-brand-50" : "border-line bg-surface"}`}
            >
              <UploadCloud className="size-7 text-muted" aria-hidden />
              <p className="text-sm text-muted">Drag a .xlsx, .csv or .zip file here, or</p>
              <Button variant="outline-brand" className="min-h-11" disabled={progress !== null} onClick={() => input.current?.click()}>Choose file</Button>
              <input ref={input} type="file" accept={ACCEPT} className="sr-only" aria-label="Choose a file to import" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
              <p className="text-xs text-muted">Up to 5,000 products. ZIP: up to 200 MB with an images/ folder next to products.xlsx or products.csv.</p>
            </div>
            {progress !== null ? (
              <div aria-live="polite" className="rounded-lg border border-line bg-surface p-3 text-sm">
                <div className="flex justify-between"><span>{progress < 100 ? "Uploading…" : "Checking your file…"}</span><span className="text-muted">{progress}%</span></div>
                <progress className="mt-2 h-1.5 w-full" value={progress} max={100} aria-label="Upload progress" />
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
          <h2 id="recent-h" className="text-base font-semibold text-ink">Recent imports</h2>
          <ul className="grid gap-2">
            {recent.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">{j.originalName ?? "Import"}</p>
                  <p className="text-muted">{fmtDate(j.createdAt)} · {j.totalRows} rows · {j.createdCount} created, {j.updatedCount} updated{j.errorCount ? `, ${j.errorCount} with errors` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <JobBadge status={j.status} />
                  {j.hasErrorReport ? <a className="min-h-11 px-2 py-2 text-brand-700 underline" href={`/api/bulk/jobs/${j.id}/download?which=errors`}>Error report</a> : null}
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
  const running = job.status === "queued" || job.status === "processing";
  const settled = ["completed", "completed_with_errors", "failed", "cancelled"].includes(job.status);
  const pct = job.totalRows ? Math.min(100, Math.round((job.processedRows / job.totalRows) * 100)) : 0;
  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-ink">{job.originalName}</h2>
            <p className="text-sm text-muted">{job.options.mode === "create" ? "Create new only" : "Create and update by SKU"}{job.options.submitForReview ? " · submit for review" : " · save as drafts"}</p>
          </div>
          <JobBadge status={job.status} />
        </div>

        {error ? <Alert tone="danger">{error}</Alert> : null}
        {job.lastError ? <Alert tone="danger">{job.lastError}</Alert> : null}

        {job.status === "uploaded" || job.status === "validating" ? (
          <p className="text-sm text-muted" aria-live="polite">We are checking every row. Large files take a minute. You can leave this page and come back.</p>
        ) : null}

        {job.status === "validated" ? (
          <>
            <dl className="grid grid-cols-3 gap-3 text-center">
              <Count label="Rows" value={job.totalRows} />
              <Count label="Ready" value={validRows} tone="success" />
              <Count label="With errors" value={job.errorCount} tone={job.errorCount ? "danger" : undefined} />
            </dl>
            {warnings.length ? <Alert tone="warning">{warnings.join(" ")}</Alert> : null}
            {job.errorCount > 0 ? <ErrorTable job={job} /> : <Alert tone="success">No problems found. Nothing has been imported yet; confirm below.</Alert>}
            <p className="text-sm text-muted">Imports only change your drafts. Photos from a ZIP go through the same staff approval as photos you add one by one, so they show on your live listings only after they are approved.</p>
            <div className="flex flex-wrap gap-2">
              {job.errorCount === 0 ? (
                <Button className="min-h-11" disabled={pending} onClick={() => onConfirm(false)}>Import {validRows} product{validRows === 1 ? "" : "s"}</Button>
              ) : validRows > 0 ? (
                <Button className="min-h-11" variant="accent" disabled={pending} onClick={() => onConfirm(true)}>Import {validRows} valid, skip {job.errorCount} with errors</Button>
              ) : null}
              <Button variant="outline" className="min-h-11" disabled={pending} onClick={onCancel}>Cancel import</Button>
            </div>
          </>
        ) : null}

        {running ? (
          <div aria-live="polite" className="space-y-2">
            <div className="flex justify-between text-sm"><span>{job.status === "queued" ? "Waiting for a worker…" : `Imported ${job.processedRows} of ${job.totalRows}`}</span><span className="text-muted">{pct}%</span></div>
            <progress className="h-2 w-full" value={pct} max={100} aria-label="Import progress" />
            <p className="text-xs text-muted">{job.createdCount} created · {job.updatedCount} updated · {job.imageCount} photos uploaded{job.errorCount ? ` · ${job.errorCount} with errors` : ""}. You can leave this page; the import continues.</p>
            <Button variant="outline" className="min-h-11" disabled={pending} onClick={onCancel}>Stop import</Button>
          </div>
        ) : null}

        {settled ? (
          <>
            {job.status === "completed" || job.status === "completed_with_errors" ? (
              <dl className="grid grid-cols-2 gap-3 text-center sm:grid-cols-4">
                <Count label="Created" value={job.createdCount} tone="success" />
                <Count label="Updated" value={job.updatedCount} />
                <Count label="Photos" value={job.imageCount} />
                <Count label="With errors" value={job.errorCount} tone={job.errorCount ? "danger" : undefined} />
              </dl>
            ) : null}
            {job.status === "cancelled" ? <p className="text-sm text-muted">Cancelled. Rows already imported stay in your drafts.</p> : null}
            {job.errorCount > 0 ? <ErrorTable job={job} /> : null}
            {job.status === "completed" || job.status === "completed_with_errors" ? (
              <p className="text-sm text-muted">Your products are in <a className="text-brand-700 underline" href="/listings">Listings</a>. New photos wait for staff approval{job.options.submitForReview ? "; products you submitted follow the normal review" : ". Submit the products for review when you are ready"}.</p>
            ) : null}
          </>
        ) : null}

        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          {job.hasErrorReport ? <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold hover:bg-canvas" href={`/api/bulk/jobs/${job.id}/download?which=errors`}><Download className="size-4" aria-hidden /> Download error report</a> : null}
          {job.status !== "queued" && job.status !== "processing" && job.status !== "validating" ? <Button variant="ghost" className="min-h-11" onClick={onReset}>Start another import</Button> : null}
        </div>
      </CardBody>
    </Card>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: "success" | "danger" }) {
  return (
    <div className="rounded-lg border border-line bg-canvas p-3">
      <dd className={`text-xl font-semibold ${tone === "success" ? "text-success" : tone === "danger" ? "text-danger" : "text-ink"}`}>{value.toLocaleString("en-IN")}</dd>
      <dt className="text-xs text-muted">{label}</dt>
    </div>
  );
}

function ErrorTable({ job }: { job: BulkJobView }) {
  const shown = job.sampleErrors;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-ink">Problems found ({job.errorCount} row{job.errorCount === 1 ? "" : "s"})</h3>
      <div className="max-h-80 overflow-auto rounded-lg border border-line">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-canvas text-xs text-muted"><tr><th className="p-2">Row</th><th className="p-2">Column</th><th className="p-2">Problem</th></tr></thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.row}-${e.column}-${i}`} className="border-t border-line align-top">
                <td className="p-2 tabular-nums">{e.row || "File"}</td>
                <td className="p-2 font-mono text-xs">{e.column || "-"}</td>
                <td className="p-2 text-danger">{e.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">Showing the first {shown.length}. The error report has every row with its problems, so you can fix and upload just those rows.</p>
    </div>
  );
}
