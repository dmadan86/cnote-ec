import { fakeLeadPrecisionRecall, listLabelQueue } from "@cnote/enquiry";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader, Stat } from "@cnote/ui";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Mono } from "@/components/table";
import { labelEnquiryAction } from "@/features/kyc/label-actions";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "Fake-lead labels" };
const TABS = [{ value: "todo", label: "To label" }, { value: "done", label: "Labelled" }] as const;
const pct = (v: number | null) => (v === null ? "no labels yet" : `${Math.round(v * 100)}%`);

export default async function FraudLabelsPage({ searchParams }: PageProps<"/fraud-labels">) {
  const sp = await searchParams;
  const view = TABS.find((t) => t.value === one(sp.view))?.value ?? "todo";
  await requireStaff(`/fraud-labels?view=${view}`, "enquiries.review");
  const [items, pr] = await Promise.all([
    safe("enquiry.listLabelQueue", () => listLabelQueue({ labelled: view === "done", limit: 50 })),
    safe("enquiry.fakeLeadPrecisionRecall", () => fakeLeadPrecisionRecall()),
  ]);
  return (
    <>
      <PageHeader title="Fake-lead labels" description="Ground truth for the fake-lead detector (ADR-002: precision ≥ 90%, recall ≥ 80%). Label what you are sure of; the riskiest unlabelled enquiries come first. Labels never change an enquiry by themselves." />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Precision" value={pr ? pct(pr.precision) : "—"} />
        <Stat label="Recall" value={pr ? pct(pr.recall) : "—"} />
        <Stat label="Labelled" value={pr ? String(pr.labelled) : "—"} />
      </div>
      <p className="text-sm"><a href="/fraud-labels/export" className="font-medium text-brand-700 hover:underline">Download labelled data (CSV, no free text)</a></p>
      <LinkTabs label="View" variant="underline" items={TABS.map((t) => ({ href: `/fraud-labels?view=${t.value}`, label: t.label, active: t.value === view }))} />
      {items === null ? <Alert tone="warning">The queue is currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="Nothing here" description={view === "todo" ? "No unlabelled enquiries with signals." : "No labels yet."} /> : null}
      <ul className="space-y-3">
        {(items ?? []).map((i) => (
          <li key={i.enquiryId}>
            <Card><CardBody className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-semibold">{i.title}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                  <Mono>{i.enquiryId.slice(0, 8)}</Mono> {fmtDate(i.createdAt)} · {i.status}
                  <Badge tone={i.riskScore >= 60 ? "danger" : i.riskScore >= 40 ? "warning" : "neutral"}>risk {i.riskScore}</Badge>
                  <Badge>intent {i.intentScore ?? "—"}</Badge>
                  {i.label ? <Badge tone={i.label === "genuine" ? "success" : "danger"}>{i.label}</Badge> : null}
                </p>
              </div>
              {i.riskReasons.length ? <p className="text-sm text-muted">{i.riskReasons.join("; ")} · {i.uaFamily}</p> : null}
              <ActionForm action={labelEnquiryAction} successMessage="Label saved." className="flex flex-wrap gap-2">
                <input type="hidden" name="enquiryId" value={i.enquiryId} />
                {(["genuine", "fake", "spam", "unreachable"] as const).map((l) => (
                  <SubmitButton key={l} name="label" value={l} size="sm" variant={l === "genuine" ? "outline" : "outline-brand"}>{l[0]!.toUpperCase() + l.slice(1)}</SubmitButton>
                ))}
              </ActionForm>
            </CardBody></Card>
          </li>
        ))}
      </ul>
    </>
  );
}
