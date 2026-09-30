"use client";
import { useEffect, useState, useTransition } from "react";
import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert, Button, Card, CardBody } from "@cnote/ui";
import type { BulkJobView } from "@cnote/bulk";
import { createExportAction } from "./actions";
import { JobBadge, useFmtDate } from "./job-status";

export function ExportPanel({ initialJobs }: { initialJobs: BulkJobView[] }) {
  const t = useTranslations("listings.bulk.export");
  const fmtDate = useFmtDate();
  const [jobs, setJobs] = useState(initialJobs);
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [images, setImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const busy = jobs.some((j) => j.status === "queued" || j.status === "processing");

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch("/api/bulk/imports?kind=export", { cache: "no-store" });
        const body = (await r.json()) as { jobs?: BulkJobView[] };
        if (body.jobs) setJobs(body.jobs);
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => clearInterval(t);
  }, [busy]);

  function create() {
    setError(null);
    start(async () => {
      const r = await createExportAction({ format, includeImages: images });
      if (r.ok) setJobs((j) => [r.data, ...j]);
      else setError(r.error);
    });
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardBody className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-ink">{t("title")}</h2>
            <p className="mt-1 text-sm text-muted">
              {t("intro")}
            </p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink">{t("format")}</legend>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="fmt" checked={format === "xlsx"} onChange={() => setFormat("xlsx")} className="size-4" /> {t("xlsx")}</label>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="fmt" checked={format === "csv"} onChange={() => setFormat("csv")} className="size-4" /> {t("csv")}</label>
          </fieldset>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} className="mt-1 size-4" />
            <span><b>{t("includePhotos")}</b> {t("includePhotosNote")}</span>
          </label>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button className="min-h-11" disabled={pending || busy} onClick={create}>{busy ? t("preparing") : t("create")}</Button>
        </CardBody>
      </Card>

      {jobs.length ? (
        <section aria-labelledby="exp-h" className="space-y-2">
          <h2 id="exp-h" className="text-base font-semibold text-ink">{t("yours")}</h2>
          <ul className="grid gap-2" aria-live="polite">
            {jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-surface p-3 text-sm">
                <div>
                  <p className="font-medium text-ink">{fmtDate(j.createdAt)} · {j.options.exportFormat === "csv" ? "CSV" : t("excel")}{j.options.includeImages ? t("plusPhotos") : ""}</p>
                  <p className="text-muted">{j.status === "completed" ? t("listingsCount", { count: j.totalRows }) : j.lastError ?? ""}</p>
                  {j.options && "warnings" in j.options && (j.options as { warnings?: string[] }).warnings?.length ? <p className="text-warning">{(j.options as { warnings?: string[] }).warnings!.join(" ")}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <JobBadge status={j.status} />
                  {j.hasResult ? (
                    <a className="inline-flex min-h-11 items-center gap-2 rounded-full border border-brand-600 px-4 font-semibold text-brand-700 hover:bg-brand-50" href={`/api/bulk/jobs/${j.id}/download?which=result`}><Download className="size-4" aria-hidden /> {t("download")}</a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
