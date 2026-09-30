import type { Metadata } from "next";
import { describeSubject, listMyAppeals, type AppealView } from "@cnote/compliance";
import { Badge, Card, CardBody, EmptyState, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";

export const metadata: Metadata = { title: "Appeals" };

const STATUS = {
  open: { tone: "neutral", label: "Under review" },
  in_progress: { tone: "neutral", label: "Under review" },
  resolved: { tone: "success", label: "Upheld" },
  rejected: { tone: "danger", label: "Decision stands" },
} as const;
const TYPE_LABEL: Record<string, string> = { listing_version: "Listing update", listing_image: "Product image", review: "Review", comment: "Question or comment", storefront_version: "Storefront update" };
const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeZone: "Asia/Kolkata" });

async function withTitles(appeals: AppealView[]) {
  return Promise.all(appeals.map(async (a) => ({ a, title: (await describeSubject(a.subjectType, a.subjectId).catch(() => null))?.title ?? null })));
}

export default async function AppealsPage() {
  const session = await requireSeller("/appeals");
  const res = await load(async () => withTitles(await listMyAppeals(session.personId)));
  return (
    <div className="space-y-6">
      <PageHeader title="Appeals" description="If we rejected your listing, image, review or storefront change and you disagree, appeal from the rejected item. Our team reviews every appeal." />
      {!res.ok ? (
        <EmptyState title="Appeals are unavailable right now" description="Please try again in a moment." />
      ) : res.data.length === 0 ? (
        <EmptyState title="No appeals yet" description="You can appeal a rejection from the item that was rejected, using Appeal this decision." />
      ) : (
        <ul className="space-y-4">
          {res.data.map(({ a, title }) => (
            <li key={a.id}>
              <Card>
                <CardBody className="space-y-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-base font-semibold text-ink">{title ?? TYPE_LABEL[a.subjectType]}</h2>
                    <Badge tone={STATUS[a.status].tone}>{STATUS[a.status].label}</Badge>
                  </div>
                  <p className="text-muted">{TYPE_LABEL[a.subjectType]} · appealed {fmt.format(new Date(a.createdAt))}</p>
                  <p className="whitespace-pre-wrap text-ink">{a.reason}</p>
                  {a.decisionNote ? (
                    <div className="rounded-lg border border-line bg-canvas p-3">
                      <p className="font-medium text-ink">Our response</p>
                      <p className="mt-1 whitespace-pre-wrap">{a.decisionNote.replace(/\n\[follow-up\].*$/s, "")}</p>
                      {a.needsFollowUp ? <p className="mt-2 text-muted">Please resubmit the item for review; we will prioritise it.</p> : null}
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
