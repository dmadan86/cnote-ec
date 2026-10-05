import { hasPrivilege } from "@cnote/admin";
import { listPendingRegistryReviews } from "@cnote/identity";
import { Alert, Badge, Card, CardBody, EmptyState, Input, PageHeader } from "@cnote/ui";
import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Mono } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, safe } from "@/lib/util";
import { resolveRegistryReviewAction } from "../actions";

export const metadata = { title: "Udyam / MCA reviews" };

export default async function RegistryReviewsPage() {
  const { staff } = await requireStaff("/businesses/registry-reviews", "businesses.read");
  const items = await safe("identity.listPendingRegistryReviews", () => listPendingRegistryReviews(100));
  const canVerify = hasPrivilege(staff, "businesses.verify");
  return (
    <>
      <PageHeader title="Udyam / MCA reviews" description="Registry checks where the name or address only partly matched, or the number is already verified for another business. Approving adds the verified stamp and trust points; it never changes the GST tier." />
      {items === null ? <Alert tone="warning">The queue is currently unavailable.</Alert> : items.length === 0 ? <EmptyState title="Nothing to review" /> : (
        <ul className="space-y-3">
          {items.map((r) => (
            <li key={r.id}>
              <Card><CardBody className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold"><Link href={`/businesses/${r.businessId}`} className="text-brand-700 hover:underline">{r.businessName}</Link> <Badge>{r.kind === "udyam" ? "Udyam" : "MCA / CIN"}</Badge>{r.dispute ? <> <Badge tone="warning">number held elsewhere</Badge></> : null}</p>
                  <p className="text-xs text-muted">{fmtDate(r.createdAt)} · score {r.score ?? "—"} · <Mono>{r.number ?? "—"}</Mono></p>
                </div>
                <p className="text-sm text-muted">{r.reasons.join(" ") || "—"}</p>
                {canVerify ? (
                  <ActionForm action={resolveRegistryReviewAction} confirm="Record this decision? It is written to the audit log." successMessage="Decision recorded." className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="businessId" value={r.businessId} />
                    <div><label htmlFor={`rn-${r.id}`} className="block text-xs text-muted">Note (optional)</label><Input id={`rn-${r.id}`} name="note" maxLength={500} className="w-72" /></div>
                    <SubmitButton name="decision" value="approved" size="sm">Approve</SubmitButton>
                    <SubmitButton name="decision" value="rejected" variant="danger" size="sm">Reject</SubmitButton>
                  </ActionForm>
                ) : null}
              </CardBody></Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
