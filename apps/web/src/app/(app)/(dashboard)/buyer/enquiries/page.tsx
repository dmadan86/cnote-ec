import { BOARD_STATUSES, boardCounts, boardStatus, listBuyerEnquiries, type BoardStatus } from "@cnote/enquiry";
import { requireBusiness } from "@cnote/next-kit";
import { Badge, Card, CardBody, Container, EmptyState, PageHeader, buttonClasses, type BadgeTone } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";
import { ExpiryCountdown } from "@/features/enquiry/expiry";
import { IntentScore } from "@/features/enquiry/intent-score";
import { EnquiryStatusBadge } from "@/features/enquiry/status";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "titles" });
  return { title: t("enquiries") };
}

const TONE: Record<BoardStatus, BadgeTone> = { open: "brand", quoted: "success", closed: "neutral", expired: "warning" };
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function BuyerEnquiriesPage(props: PageProps<"/buyer/enquiries">) {
  const s = await requireBusiness("/buyer/enquiries");
  const locale = await getRequestLocale();
  const t = await getTranslations({ locale, namespace: "buyer" });
  const tr = await getTranslations({ locale, namespace: "rfq2.board" });
  const sp = await props.searchParams;
  const requested = first(sp.status);
  const filter = (BOARD_STATUSES as readonly string[]).includes(requested ?? "") ? (requested as BoardStatus) : null;
  const date = { format: (d: Date) => formatDate(d, locale, { day: "numeric", month: "short", year: "numeric" }) };

  const all = await listBuyerEnquiries(s.business.id);
  const now = new Date();
  const counts = boardCounts(all, now);
  const enquiries = filter ? all.filter((e) => boardStatus(e, now) === filter) : all;
  const chips: { key: BoardStatus | "all"; count: number }[] = [{ key: "all", count: all.length }, ...BOARD_STATUSES.map((k) => ({ key: k, count: counts[k] }))];

  return (
    <Container className="py-8">
      <PageHeader
        title={t("enquiriesTitle")}
        description={t("enquiriesDescription")}
        actions={<Link href="/rfq/new" className={buttonClasses("accent")}>{t("postRequirement")}</Link>}
      />
      {all.length > 0 ? (
        <nav aria-label={tr("filterLabel")} className="mt-6">
          <ul className="flex flex-wrap gap-2">
            {chips.map((c) => {
              const active = (filter ?? "all") === c.key;
              return (
                <li key={c.key}>
                  <Link
                    href={c.key === "all" ? "/buyer/enquiries" : `/buyer/enquiries?status=${c.key}`}
                    aria-current={active ? "page" : undefined}
                    className={buttonClasses(active ? "primary" : "outline", "md", "min-h-11 sm:min-h-10")}
                  >
                    {tr(`status.${c.key}`)} ({c.count})
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
      <div className="mt-6">
        {all.length === 0 ? (
          <EmptyState
            title={t("enquiriesEmptyTitle")}
            description={t("enquiriesEmptyDescription")}
            action={<Link href="/rfq/new" className={buttonClasses("accent")}>{t("postRequirement")}</Link>}
          />
        ) : enquiries.length === 0 ? (
          <p className="rounded-lg border border-line bg-surface p-6 text-sm text-muted" role="status">
            {tr("emptyFilter", { status: tr(`status.${filter ?? "all"}`).toLowerCase() })}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {enquiries.map((e) => {
              const status = boardStatus(e, now);
              const cap = e.sellerCap ?? 3;
              const matched = e.matches.filter((m) => m.status === "offered" || m.status === "accepted").length;
              return (
                <li key={e.id}>
                  <Link href={`/buyer/enquiries/${e.id}`} className="block rounded-card focus-visible:outline-2 focus-visible:outline-brand-600">
                    <Card className="transition-colors hover:border-brand-600">
                      <CardBody className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-start justify-between gap-3">
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
                            <Badge tone={TONE[status]}>
                              <span className="sr-only">{tr("statusLabel")}: </span>
                              {tr(`status.${status}`)}
                            </Badge>
                            {status === "open" || status === "quoted" ? null : <EnquiryStatusBadge enquiry={e} />}
                          </div>
                        </div>
                        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-ink">
                          <div>
                            <dt className="sr-only">{tr("quotesLabel")}</dt>
                            <dd className="font-medium">{tr("quotesReceived", { count: e.quoteCount ?? 0 })}</dd>
                          </div>
                          <div>
                            <dt className="sr-only">{tr("suppliersLabel")}</dt>
                            <dd>{tr("matchedOf", { matched, max: cap })}</dd>
                          </div>
                          {status === "closed" ? null : (
                            <div>
                              <dt className="sr-only">{tr("deadlineLabel")}</dt>
                              <dd className="text-muted"><ExpiryCountdown expiresAt={e.expiresAt} /></dd>
                            </div>
                          )}
                        </dl>
                      </CardBody>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Container>
  );
}
