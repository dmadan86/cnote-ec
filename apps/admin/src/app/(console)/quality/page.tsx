import { hasPrivilege } from "@cnote/admin";
import { listCategoryStatuses, listForLabelling, minAccuracy, minLabels, qualityChecksEnabled } from "@cnote/quality";
import { Alert, Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import { redirect } from "next/navigation";
import { Mono } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";
import { CategoryToggle, EnableForm, LabelForm } from "./forms";

export const metadata = { title: "Quality checks" };
const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);

export default async function QualityPage({ searchParams }: { searchParams: Promise<{ category?: string | string[]; all?: string | string[] }> }) {
  const { staff } = await requireStaff("/quality");
  if (!hasPrivilege(staff, "quality.review")) redirect("/no-access?need=quality.review");
  const sp = await searchParams;
  const category = one(sp.category);
  const all = one(sp.all) === "1";
  const [cats, items] = await Promise.all([
    safe("quality.listCategoryStatuses", () => listCategoryStatuses()),
    safe("quality.listForLabelling", () => listForLabelling({ categorySlug: category, unlabelledOnly: !all, limit: 50 })),
  ]);
  return (
    <>
      <PageHeader title="Quality checks (ADR-015)" description={`Pre-dispatch photo checks are advisory evidence, never pass or fail. Label what the truth was for each result; a category can be added only when accuracy is above ${Math.round(minAccuracy() * 100)}% on at least ${minLabels()} labels.`} />
      {!qualityChecksEnabled() ? <Alert tone="info">QUALITY_CHECKS_ENABLED is off: sellers do not see the photo panel and nothing new is analysed.</Alert> : null}
      <Card><CardBody className="space-y-3">
        <h2 className="text-base font-semibold">Categories and accuracy</h2>
        {cats === null ? <Alert tone="warning">Categories are currently unavailable.</Alert> : null}
        {cats && cats.length === 0 ? <EmptyState title="No category has run yet" description="Enable the pilot category below or set QUALITY_CHECK_CATEGORIES." /> : null}
        <ul className="divide-y divide-line">
          {(cats ?? []).map((c) => (
            <li key={c.categorySlug} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium"><Mono>{c.categorySlug}</Mono> {c.pilot ? <Badge tone="neutral">Pilot</Badge> : null} <Badge tone={c.enabled ? "success" : "neutral"}>{c.enabled ? "Enabled" : "Off"}</Badge>{c.fromEnv ? <Badge tone="neutral">Set in environment</Badge> : null}</p>
                <p className="text-xs text-muted">Accuracy {pct(c.accuracy)} on {c.labelled} labels ({c.correct} correct). {c.meetsGate ? "Meets the expansion gate." : `Gate: more than ${Math.round(c.minAccuracy * 100)}% with at least ${c.minLabels} labels.`}{c.updatedAt ? ` Changed ${fmtDate(c.updatedAt)}.` : ""}</p>
              </div>
              {c.fromEnv ? null : <CategoryToggle slug={c.categorySlug} enabled={c.enabled} />}
            </li>
          ))}
        </ul>
        <details className="text-sm"><summary className="cursor-pointer text-brand-700">Enable another category</summary>
          <div className="mt-2"><EnableForm /></div></details>
      </CardBody></Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{all ? "All results" : "Results to label"}</h2>
        <a className="text-sm text-brand-700 hover:underline" href={all ? "/quality" : "/quality?all=1"}>{all ? "Show unlabelled only" : "Show labelled too"}</a>
      </div>
      {items === null ? <Alert tone="warning">Results are currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="Nothing to label" description="New results appear here after sellers share photos." /> : null}
      <ul className="space-y-3">
        {(items ?? []).map((i) => (
          <li key={i.resultId}>
            <Card><CardBody className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{i.check} <span className="text-sm font-normal text-muted">· <Mono>{i.categorySlug}</Mono> · order <Mono>{i.orderId.slice(0, 8)}</Mono></span></p>
                <div className="flex gap-1.5"><Badge tone="neutral">Model: {i.result} ({Math.round(i.confidence * 100)}%)</Badge>{i.label ? <Badge tone={i.label === i.result ? "success" : "warning"}>Label: {i.label}</Badge> : null}</div>
              </div>
              {i.note ? <p className="text-sm text-muted">{i.note}</p> : null}
              <p className="text-xs text-muted">Expected: {i.expected.quantity ?? "?"} {i.expected.unit ?? ""} · {i.expected.productTitle}{Object.keys(i.expected.attributes).length ? ` · ${Object.entries(i.expected.attributes).map(([k, v]) => `${k}: ${v}`).join(", ")}` : ""}</p>
              {i.mediaIds.length ? (
                <ul className="flex flex-wrap gap-2" aria-label="Photos">
                  {i.mediaIds.map((m, n) => (
                    <li key={m}>{/* eslint-disable-next-line @next/next/no-img-element -- private authenticated route */}
                      <img src={`/api/quality/media/${m}`} alt={`Dispatch photo ${n + 1}`} className="size-24 rounded-md border border-line object-cover" loading="lazy" /></li>
                  ))}
                </ul>
              ) : <p className="text-xs text-muted">Photos were deleted under the retention policy; label from the notes only.</p>}
              <LabelForm resultId={i.resultId} current={i.label} />
            </CardBody></Card>
          </li>
        ))}
      </ul>
    </>
  );
}
