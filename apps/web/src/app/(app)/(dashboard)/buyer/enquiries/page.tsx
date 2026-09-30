import { listBuyerEnquiries } from "@cnote/enquiry";
import { requireBusiness } from "@cnote/next-kit";
import { Card, CardBody, Container, EmptyState, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { IntentScore } from "@/features/enquiry/intent-score";
import { EnquiryStatusBadge } from "@/features/enquiry/status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("enquiries") };
}

export default async function BuyerEnquiriesPage() {
  const s = await requireBusiness("/buyer/enquiries");
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "buyer" });
  const date = { format: (d: Date) => formatDate(d, locale, { day: "numeric", month: "short", year: "numeric" }) };
  const enquiries = await listBuyerEnquiries(s.business.id);
  return (
    <Container className="py-8">
      <PageHeader
        title={t("enquiriesTitle")}
        description={t("enquiriesDescription")}
        actions={<Link href="/rfq/new" className={buttonClasses("accent")}>{t("postRequirement")}</Link>}
      />
      <div className="mt-6">
        {enquiries.length === 0 ? (
          <EmptyState
            title={t("enquiriesEmptyTitle")}
            description={t("enquiriesEmptyDescription")}
            action={<Link href="/rfq/new" className={buttonClasses("accent")}>{t("postRequirement")}</Link>}
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
                          {t("sellersCount", { count: e.matches.length })}
                          {e.matches.some((m) => m.status === "accepted") ? ` · ${t("repliedCount", { count: e.matches.filter((m) => m.status === "accepted").length })}` : ""}
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
