import { listBuyerEnquiries } from "@cnote/enquiry";
import { requireBusiness } from "@cnote/next-kit";
import { Card, CardBody, Container, EmptyState, IntentScore, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { EnquiryStatusBadge } from "@/features/enquiry/status";

export const metadata: Metadata = { title: "Your requirements" };
const date = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });

export default async function BuyerEnquiriesPage() {
  const s = await requireBusiness("/buyer/enquiries");
  const enquiries = await listBuyerEnquiries(s.business.id);
  return (
    <Container className="py-8">
      <PageHeader
        title="Your requirements"
        description="Every requirement you posted, who it was offered to, and where it stands."
        actions={<Link href="/rfq/new" className={buttonClasses("accent")}>Post a requirement</Link>}
      />
      <div className="mt-6">
        {enquiries.length === 0 ? (
          <EmptyState
            title="No requirements yet"
            description="Post what you need and we will offer it to the best matching sellers."
            action={<Link href="/rfq/new" className={buttonClasses("accent")}>Post a requirement</Link>}
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {enquiries.map((e) => (
              <li key={e.id}>
                <Link href={`/buyer/enquiries/${e.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                  <Card className="transition-colors hover:border-brand-600">
                    <CardBody className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-ink">{e.title}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {date.format(new Date(e.createdAt))}
                          {e.quantity ? ` · ${e.quantity} ${e.quantityUnit ?? ""}` : ""}
                          {e.category ? ` · ${e.category.name}` : ""}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {e.intentScore !== null ? <IntentScore score={e.intentScore} /> : null}
                        <span className="text-xs text-muted">
                          {e.matches.length} seller{e.matches.length === 1 ? "" : "s"}
                          {e.matches.some((m) => m.status === "accepted") ? ` · ${e.matches.filter((m) => m.status === "accepted").length} replied` : ""}
                        </span>
                        <EnquiryStatusBadge enquiry={e} />
                      </div>
                    </CardBody>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Container>
  );
}
