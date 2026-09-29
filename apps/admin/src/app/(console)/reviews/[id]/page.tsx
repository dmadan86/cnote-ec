import { hasPrivilege } from "@cnote/admin";
import { getReview } from "@cnote/ai";
import { getListing } from "@cnote/catalogue";
import { getEnquiryForOps } from "@cnote/enquiry";
import { Alert, Card, CardBody, CardHeader, CardTitle, Field, Money, PageHeader, Textarea } from "@cnote/ui";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { ConfidenceBadge } from "@/components/confidence";
import { Mono } from "@/components/table";
import { requireStaff } from "@/lib/auth";
import { fmtDate, json, safe } from "@/lib/util";
import { resolveReviewAction } from "../actions";

export const metadata = { title: "Review item" };

export default async function ReviewDetailPage({ params }: PageProps<"/reviews/[id]">) {
  const { id } = await params;
  const { staff } = await requireStaff(`/reviews/${id}`, "reviews.read");
  const item = await safe("ai.getReview", () => getReview(id));
  if (item === null) return <Alert tone="warning">The review queue is currently unavailable.</Alert>;
  if (!item || item.status !== "open") notFound(); // resolved by someone else, or never existed

  const neededPrivilege = item.subjectType === "listing" ? "listings.moderate" : item.subjectType === "enquiry" ? "enquiries.review" : null;
  const canResolve = hasPrivilege(staff, "reviews.resolve") && (!neededPrivilege || hasPrivilege(staff, neededPrivilege));
  const enquiry = item.subjectType === "enquiry" && hasPrivilege(staff, "enquiries.review") ? await safe("enquiry.getEnquiryForOps", () => getEnquiryForOps(item.subjectId)) : null;
  const listing = item.subjectType === "listing" ? await safe("catalogue.getListing", () => getListing(item.subjectId)) : null;

  return (
    <>
      <PageHeader title={`Review: ${item.capability}`} description={<><Link href="/reviews" className="text-brand-700 hover:underline">Queue</Link> · queued {fmtDate(item.createdAt)}</>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>AI output</CardTitle><ConfidenceBadge value={item.confidence} /></CardHeader>
          <CardBody className="space-y-3">
            <p className="text-sm"><span className="text-muted">Why it was flagged:</span> {item.reason}</p>
            <pre className="max-h-96 overflow-auto rounded-lg bg-canvas p-3 text-xs">{json(item.output)}</pre>
          </CardBody>
        </Card>
        <Card>
          <CardHeader><CardTitle>Subject: {item.subjectType}</CardTitle></CardHeader>
          <CardBody className="space-y-2 text-sm">
            <p>ID <Mono>{item.subjectId}</Mono></p>
            {item.subjectType === "listing" ? (
              listing ? (
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted">Title</dt><dd className="font-medium">{listing.title}</dd>
                  <dt className="text-muted">Category</dt><dd>{listing.category.name}</dd>
                  <dt className="text-muted">Price</dt><dd>{listing.pricePaise != null ? <Money paise={listing.pricePaise} unit={listing.priceUnit} /> : "—"}</dd>
                  <dt className="text-muted">MOQ</dt><dd>{listing.moq != null ? `${listing.moq} ${listing.moqUnit ?? ""}` : "—"}</dd>
                  <dt className="text-muted">Seller</dt><dd>{hasPrivilege(staff, "businesses.read") ? <Link className="text-brand-700 hover:underline" href={`/businesses/${listing.sellerBusinessId}`}>{listing.sellerBusinessId.slice(0, 8)}</Link> : listing.sellerBusinessId.slice(0, 8)}</dd>
                  <dt className="text-muted">Status</dt><dd>{listing.status} · moderation {listing.moderationStatus}{listing.aiGenerated ? " · AI-generated" : ""}</dd>
                  <dt className="text-muted">Description</dt><dd className="whitespace-pre-wrap">{listing.description}</dd>
                </dl>
              ) : (
                <Alert tone="warning">Listing preview unavailable.</Alert>
              )
            ) : item.subjectType === "enquiry" ? (
              enquiry ? (
                <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
                  <dt className="text-muted">Title</dt><dd className="font-medium">{enquiry.title}</dd>
                  <dt className="text-muted">Requirement</dt><dd className="whitespace-pre-wrap">{enquiry.requirement}</dd>
                  <dt className="text-muted">Quantity</dt><dd>{enquiry.quantity != null ? `${enquiry.quantity} ${enquiry.quantityUnit ?? ""}` : "—"}</dd>
                  <dt className="text-muted">Target price</dt><dd>{enquiry.targetPricePaise != null ? <Money paise={enquiry.targetPricePaise} /> : "—"}</dd>
                  <dt className="text-muted">Deliver to</dt><dd>{[enquiry.deliveryCity, enquiry.deliveryPincode].filter(Boolean).join(" ") || "—"}</dd>
                  <dt className="text-muted">Intent score</dt><dd>{enquiry.intentScore ?? "—"}</dd>
                  <dt className="text-muted">Status</dt><dd>{enquiry.status} · moderation {enquiry.moderationStatus}</dd>
                </dl>
              ) : (
                <Alert tone="warning">Enquiry preview unavailable.</Alert>
              )
            ) : (
              <p className="text-muted">No preview for this subject type.</p>
            )}
          </CardBody>
        </Card>
      </div>
      {canResolve ? (
        <Card>
          <CardHeader><CardTitle>Decision</CardTitle></CardHeader>
          <CardBody>
            <ActionForm action={resolveReviewAction} confirm="Apply this decision? It will be recorded in the audit log.">
              <input type="hidden" name="id" value={item.id} />
              {item.subjectType === "listing" ? (
                <Field label="Reason (shown to the seller if rejected)" htmlFor="reason" className="mb-3 max-w-xl">
                  <Textarea id="reason" name="reason" maxLength={500} />
                </Field>
              ) : null}
              <div className="flex gap-2">
                <SubmitButton name="outcome" value="approved">Approve</SubmitButton>
                <SubmitButton name="outcome" value="rejected" variant="danger">Reject</SubmitButton>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      ) : (
        <Alert tone="info">You can view this item but your role can&apos;t resolve it.</Alert>
      )}
    </>
  );
}
