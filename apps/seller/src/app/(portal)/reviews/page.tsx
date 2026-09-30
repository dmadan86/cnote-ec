import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { type Locale, intlTag } from "@/i18n/config";
import Link from "next/link";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import { listSellerUgc, type SellerUgcItem, type UgcStatus } from "@cnote/reviews";
import { ReplyForm } from "@/features/reviews/reply-form";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("reviews");
  return { title: t("title") };
}

const replyTone: Record<UgcStatus, { tone: "neutral" | "warning" | "success" | "danger"; key: "statusAwaiting" | "statusPublished" | "statusRejected" }> = {
  pending: { tone: "neutral", key: "statusAwaiting" },
  flagged: { tone: "neutral", key: "statusAwaiting" },
  approved: { tone: "success", key: "statusPublished" },
  rejected: { tone: "danger", key: "statusRejected" },
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function Stars({ rating, label }: { rating: number; label: string }) {
  return (
    <span role="img" aria-label={label} className="text-accent-500">
      {"★".repeat(rating)}<span className="text-line">{"★".repeat(5 - rating)}</span>
    </span>
  );
}

export default async function ReviewsPage({ searchParams }: PageProps<"/reviews">) {
  const t = await getTranslations("reviews");
  const locale = (await getLocale()) as Locale;
  const sp = await searchParams;
  const kind = first(sp.kind) === "comment" ? "comment" : "review";
  const needsReply = first(sp.filter) === "unanswered";
  const cursor = first(sp.cursor);
  const session = await requireSeller("/reviews");

  const [ugc, listings] = await Promise.all([
    load(() => listSellerUgc(session.business.id, { kind, needsReply, cursor })),
    load(() => catalogue.listSellerListings(session.business.id)),
  ]);
  const titles = new Map(listings.ok ? listings.data.map((l) => [l.id, l.title]) : []);
  const href = (k: string, f?: string, c?: string) => `/reviews?kind=${k}${f ? `&filter=${f}` : ""}${c ? `&cursor=${c}` : ""}`;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <LinkTabs label={t("tabType")} items={[
        { href: href("review", needsReply ? "unanswered" : undefined), label: t("tabReviews"), active: kind === "review" },
        { href: href("comment", needsReply ? "unanswered" : undefined), label: t("tabQuestions"), active: kind === "comment" },
      ]} />
      <LinkTabs label={t("tabFilter")} variant="underline" items={[
        { href: href(kind), label: t("all"), active: !needsReply },
        { href: href(kind, "unanswered"), label: t("needsReply"), active: needsReply },
      ]} />
      {!ugc.ok ? <Alert tone="danger">{ugc.error}</Alert> : ugc.data.items.length === 0 ? (
        <EmptyState title={needsReply ? t("emptyNoReply") : kind === "review" ? t("emptyReviews") : t("emptyQuestions")} description={t("emptyDesc")} />
      ) : (
        <ul className="grid gap-4">
          {ugc.data.items.map((i: SellerUgcItem) => (
            <li key={`${i.kind}-${i.id}`}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Link href={`/listings/${i.listingId}/edit`} className="font-semibold text-brand-700 hover:underline">{titles.get(i.listingId) ?? t("product")}</Link>
                    {i.rating != null ? <Stars rating={i.rating} label={t("stars", { rating: i.rating })} /> : null}
                    {i.needsReply ? <Badge tone="warning">{t("needsReply")}</Badge> : null}
                  </div>
                  {i.title ? <p className="font-medium text-ink">{i.title}</p> : null}
                  <p className="whitespace-pre-wrap text-sm text-ink">{i.body}</p>
                  <p className="text-xs text-muted">{i.authorName} · {new Date(i.createdAt).toLocaleDateString(intlTag(locale), { dateStyle: "medium", timeZone: "Asia/Kolkata" })}</p>
                  {i.reply ? (
                    <div className="space-y-1 rounded-lg bg-canvas p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium">{t("yourReply")} <Badge tone={replyTone[i.reply.status].tone}>{t(replyTone[i.reply.status].key)}</Badge></p>
                      <p className="whitespace-pre-wrap">{i.reply.body}</p>
                      {i.reply.moderationNote ? <p className="text-danger">{t("reason", { note: i.reply.moderationNote })}</p> : null}
                    </div>
                  ) : null}
                  {i.kind === "review" || !i.reply || i.reply.status === "rejected" ? <ReplyForm id={i.id} kind={i.kind} existing={i.kind === "review" && !!i.reply} /> : null}
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {ugc.ok && ugc.data.nextCursor ? <Link href={href(kind, needsReply ? "unanswered" : undefined, ugc.data.nextCursor)} className="text-sm font-medium text-brand-700 hover:underline">{t("next")}</Link> : null}
    </div>
  );
}
