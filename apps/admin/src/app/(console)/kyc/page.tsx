import { hasPrivilege } from "@cnote/admin";
import { listKycReviews, type KycReviewItem } from "@cnote/identity";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { fmtDate, one, safe } from "@/lib/util";

export const metadata = { title: "KYC review" };
const TABS = [{ value: "review", label: "Needs review" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }] as const;
const tone = (v: string) => (v === "pass" ? "success" : v === "fail" ? "danger" : "warning");

export default async function KycQueuePage({ searchParams }: PageProps<"/kyc">) {
  const sp = await searchParams;
  const status = TABS.find((t) => t.value === one(sp.status))?.value ?? "review";
  const { staff } = await requireStaff(`/kyc?status=${status}`);
  if (!hasPrivilege(staff, "kyc.review")) redirect("/no-access?need=kyc.review");
  const items = await safe("identity.listKycReviews", () => listKycReviews({ status }));
  return (
    <>
      <PageHeader title="KYC review" description="Tier 2 sessions where automatic checks were ambiguous. Compare what the documents say with what the business declared. Oldest first." />
      <LinkTabs label="Status" variant="underline" items={TABS.map((t) => ({ href: `/kyc?status=${t.value}`, label: t.label, active: t.value === status }))} />
      {items === null ? <Alert tone="warning">The KYC queue is currently unavailable.</Alert> : null}
      {items && items.length === 0 ? <EmptyState title="Nothing here" description="No KYC sessions in this view." /> : null}
      <ul className="space-y-3">
        {(items ?? []).map((i: KycReviewItem) => (
          <li key={i.id}>
            <Card>
              <CardBody className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <Link href={`/kyc/${i.id}`} className="font-semibold text-brand-700 hover:underline">{i.businessName}</Link>
                  <p className="text-xs text-muted">{i.declared.gstin ?? "no GSTIN"} · submitted {fmtDate(i.createdAt)}</p>
                  {i.reasons.length ? <p className="line-clamp-2 text-sm text-muted">{i.reasons[0]}</p> : null}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {i.documents.map((d) => <Badge key={d.id} tone={tone(d.verdict)}>{d.docType.replace(/_/g, " ")}: {d.verdict}</Badge>)}
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
