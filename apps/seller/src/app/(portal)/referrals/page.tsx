import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, Stat, type BadgeTone } from "@cnote/ui";
import { listReferralsFor, referralSummary, type ReferralView } from "@cnote/promotions";
import { requireSeller } from "@/lib/auth";
import { intlTag } from "@/i18n/config";
import { load } from "@/lib/safe";
import { CopyLink } from "@/features/referrals/copy-link";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("referrals");
  return { title: t("meta.title") };
}

const TONE: Record<ReferralView["status"], BadgeTone> = { pending: "neutral", qualified: "warning", rewarded: "success", rejected: "danger", expired: "neutral" };
const KNOWN_ACTIONS = ["listing_published", "first_verified_enquiry"];

export default async function ReferralsPage() {
  const session = await requireSeller("/referrals");
  const t = await getTranslations("referrals");
  const locale = await getLocale();
  const formatDate = (iso: string | Date) => new Intl.DateTimeFormat(intlTag(locale), { dateStyle: "medium", timeZone: "Asia/Kolkata" }).format(new Date(iso));
  const id = session.business.id;
  const [summary, list] = await Promise.all([load(() => referralSummary(id)), load(() => listReferralsFor(id))]);
  const base = (process.env.SELLER_PUBLIC_URL ?? process.env.NEXT_PUBLIC_SELLER_URL ?? "http://localhost:3002").replace(/\/+$/, "");
  const credits = summary.ok ? summary.data.rewardCreditsPerSide : 10;

  return (
    <div className="space-y-8">
      <PageHeader title={t("page.title")} description={t("page.description")} />

      <Card>
        <CardHeader><CardTitle>{t("page.linkTitle")}</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          {summary.ok ? <CopyLink link={`${base}/onboarding?ref=${summary.data.code}`} /> : <Alert tone="danger">{summary.error}</Alert>}
          {summary.ok ? <p className="text-sm text-muted">{t("page.codeLabel")} <span className="font-mono text-ink">{summary.data.code}</span></p> : null}
        </CardBody>
      </Card>

      <section aria-labelledby="how" className="space-y-3">
        <h2 id="how" className="text-lg font-bold text-ink">{t("page.howTitle")}</h2>
        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            [t("page.step1Title"), t("page.step1Body")],
            [t("page.step2Title"), t("page.step2Body")],
            [t("page.step3Title"), t("page.step3Body", { credits })],
          ].map(([t, d]) => (
            <li key={t}><Card className="h-full"><CardBody><h3 className="text-sm font-semibold text-ink">{t}</h3><p className="mt-1 text-sm text-muted">{d}</p></CardBody></Card></li>
          ))}
        </ol>
        <p className="text-xs text-muted">{t("page.footnote", { cap: summary.ok ? summary.data.quarterlyCap : 10 })}</p>
      </section>

      {summary.ok ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label={t("page.statJoined")} value={summary.data.pending} hint={t("page.statJoinedHint")} />
          <Stat label={t("page.statHold")} value={summary.data.qualified} hint={t("page.statHoldHint")} />
          <Stat label={t("page.statRewarded")} value={summary.data.rewarded} />
          <Stat label={t("page.statCredits")} value={summary.data.creditsEarned} />
        </div>
      ) : null}

      <section aria-labelledby="mine" className="space-y-3">
        <h2 id="mine" className="text-lg font-bold text-ink">{t("page.listTitle")}</h2>
        {!list.ok ? <Alert tone="danger">{list.error}</Alert> : list.data.length === 0 ? (
          <EmptyState title={t("page.emptyTitle")} description={t("page.emptyDesc")} />
        ) : (
          <ul className="space-y-2">
            {list.data.map((r) => {
                            return (
                <li key={r.id}>
                  <Card>
                    <CardBody className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-ink">{r.refereeName ?? t("page.aBusiness")}</p>
                        <Badge tone={TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
                      </div>
                      <p className="text-xs text-muted">{r.qualifyingAction ? t("page.joinedWithAction", { date: formatDate(r.createdAt), action: KNOWN_ACTIONS.includes(r.qualifyingAction) ? t(`action.${r.qualifyingAction}`) : r.qualifyingAction }) : t("page.joined", { date: formatDate(r.createdAt) })}</p>
                      {r.status === "qualified" && r.holdUntil ? <p className="text-xs text-muted">{t("page.holdReward", { date: formatDate(r.holdUntil) })}</p> : null}
                      {r.status === "qualified" && r.riskFlags.length ? <p className="text-xs text-warning">{t("page.reviewing")}</p> : null}
                      {r.status === "rewarded" ? <p className="text-xs text-success">{t("page.rewardedNote", { count: r.rewardCredits ?? 0 })}</p> : null}
                      {r.status === "rejected" && r.rejectedReason ? <p className="text-xs text-danger">{t("page.reason", { reason: r.rejectedReason })}</p> : null}
                    </CardBody>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
