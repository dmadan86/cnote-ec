import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { type Locale, intlTag } from "@/i18n/config";
import Link from "next/link";
import { Alert, Badge, Card, CardBody, EmptyState, LinkTabs, PageHeader } from "@cnote/ui";
import { listSellerQuestions, type SellerQuestion, type UgcStatus } from "@cnote/reviews";
import { AnswerForm } from "@/features/questions/answer-form";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { catalogue } from "@/lib/services";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("questions");
  return { title: t("title") };
}

const tone: Record<UgcStatus, { tone: "neutral" | "success" | "danger"; key: "statusAwaiting" | "statusPublished" | "statusRejected" }> = {
  pending: { tone: "neutral", key: "statusAwaiting" },
  flagged: { tone: "neutral", key: "statusAwaiting" },
  approved: { tone: "success", key: "statusPublished" },
  rejected: { tone: "danger", key: "statusRejected" },
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Buyer questions on the seller's products, unanswered first (oldest waiting first). Answers are public once approved. */
export default async function QuestionsPage({ searchParams }: PageProps<"/questions">) {
  const t = await getTranslations("questions");
  const locale = (await getLocale()) as Locale;
  const sp = await searchParams;
  const needsAnswer = first(sp.filter) === "needs";
  const cursor = first(sp.cursor);
  const session = await requireSeller("/questions");

  const [qs, listings] = await Promise.all([
    load(() => listSellerQuestions(session.business.id, { needsAnswer, cursor })),
    load(() => catalogue.listSellerListings(session.business.id)),
  ]);
  const titles = new Map(listings.ok ? listings.data.map((l) => [l.id, l.title]) : []);
  const href = (f?: string, c?: string) => `/questions${f || c ? "?" : ""}${[f ? `filter=${f}` : "", c ? `cursor=${c}` : ""].filter(Boolean).join("&")}`;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      <LinkTabs label={t("tabFilter")} variant="underline" items={[
        { href: href(), label: t("all"), active: !needsAnswer },
        { href: href("needs"), label: t("needsAnswer"), active: needsAnswer },
      ]} />
      {!qs.ok ? <Alert tone="danger">{qs.error}</Alert> : qs.data.items.length === 0 ? (
        <EmptyState title={needsAnswer ? t("emptyNeeds") : t("emptyAll")} description={t("emptyDesc")} />
      ) : (
        <ul className="grid gap-4">
          {qs.data.items.map((q: SellerQuestion) => (
            <li key={q.id}>
              <Card>
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Link href={`/listings/${q.listingId}/edit`} className="font-semibold text-brand-700 hover:underline">{titles.get(q.listingId) ?? t("product")}</Link>
                    {q.needsAnswer ? <Badge tone="warning">{t("badgeNeeds")}</Badge> : null}
                  </div>
                  <p className="whitespace-pre-wrap text-sm font-medium text-ink">{q.body}</p>
                  <p className="text-xs text-muted">{q.authorName} · {new Date(q.createdAt).toLocaleDateString(intlTag(locale), { dateStyle: "medium", timeZone: "Asia/Kolkata" })}</p>
                  {q.answer ? (
                    <div className="space-y-1 rounded-lg bg-canvas p-3 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium">{t("yourAnswer")} <Badge tone={tone[q.answer.status].tone}>{t(tone[q.answer.status].key)}</Badge></p>
                      <p className="whitespace-pre-wrap">{q.answer.body}</p>
                      {q.answer.moderationNote ? <p className="text-danger">{t("reason", { note: q.answer.moderationNote })}</p> : null}
                    </div>
                  ) : null}
                  <AnswerForm id={q.id} existing={!!q.answer} />
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {qs.ok && qs.data.nextCursor ? <Link href={href(needsAnswer ? "needs" : undefined, qs.data.nextCursor)} className="text-sm font-medium text-brand-700 hover:underline">{t("next")}</Link> : null}
    </div>
  );
}
