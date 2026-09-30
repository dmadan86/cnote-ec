import type { Metadata } from "next";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, EmptyState, PageHeader, Stat, type BadgeTone } from "@cnote/ui";
import { listReferralsFor, referralSummary, type ReferralView } from "@cnote/promotions";
import { requireSeller } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { load } from "@/lib/safe";
import { CopyLink } from "@/features/referrals/copy-link";

export const metadata: Metadata = { title: "Refer a business" };

const STATUS: Record<ReferralView["status"], { label: string; tone: BadgeTone }> = {
  pending: { label: "Joined, not qualified yet", tone: "neutral" },
  qualified: { label: "Qualified, in safety hold", tone: "warning" },
  rewarded: { label: "Rewarded", tone: "success" },
  rejected: { label: "Not rewarded", tone: "danger" },
  expired: { label: "Expired", tone: "neutral" },
};
const ACTION: Record<string, string> = { listing_published: "published a first listing", first_verified_enquiry: "sent a first verified enquiry" };

export default async function ReferralsPage() {
  const session = await requireSeller("/referrals");
  const id = session.business.id;
  const [summary, list] = await Promise.all([load(() => referralSummary(id)), load(() => listReferralsFor(id))]);
  const base = (process.env.SELLER_PUBLIC_URL ?? process.env.NEXT_PUBLIC_SELLER_URL ?? "http://localhost:3002").replace(/\/+$/, "");
  const credits = summary.ok ? summary.data.rewardCreditsPerSide : 10;

  return (
    <div className="space-y-8">
      <PageHeader title="Refer a business" description="Share your link yourself, for example on WhatsApp. We never message people on your behalf and never read your contacts." />

      <Card>
        <CardHeader><CardTitle>Your referral link</CardTitle></CardHeader>
        <CardBody className="space-y-3">
          {summary.ok ? <CopyLink link={`${base}/onboarding?ref=${summary.data.code}`} /> : <Alert tone="danger">{summary.error}</Alert>}
          {summary.ok ? <p className="text-sm text-muted">Your code: <span className="font-mono text-ink">{summary.data.code}</span></p> : null}
        </CardBody>
      </Card>

      <section aria-labelledby="how" className="space-y-3">
        <h2 id="how" className="text-lg font-bold text-ink">How it works</h2>
        <ol className="grid gap-3 sm:grid-cols-3">
          {[
            ["1. They join with your link", "The business signs up through your link. Signing up alone earns nothing."],
            ["2. They do something real", "They get verified (GST) and publish a first approved listing, or send a first verified enquiry."],
            ["3. You both get credits", `After a 7-day safety check, you and they each get ${credits} lead credits. Credits, never cash. They expire after 90 days.`],
          ].map(([t, d]) => (
            <li key={t}><Card className="h-full"><CardBody><h3 className="text-sm font-semibold text-ink">{t}</h3><p className="mt-1 text-sm text-muted">{d}</p></CardBody></Card></li>
          ))}
        </ol>
        <p className="text-xs text-muted">There is no deadline and no bonus that grows or expires to pressure you. Each business can be referred once. You can earn from up to {summary.ok ? summary.data.quarterlyCap : 10} referrals per quarter. Referring yourself or accounts you control is not rewarded.</p>
      </section>

      {summary.ok ? (
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Joined" value={summary.data.pending} hint="Not qualified yet" />
          <Stat label="In safety hold" value={summary.data.qualified} hint="Reward after 7 days" />
          <Stat label="Rewarded" value={summary.data.rewarded} />
          <Stat label="Credits earned" value={summary.data.creditsEarned} />
        </div>
      ) : null}

      <section aria-labelledby="mine" className="space-y-3">
        <h2 id="mine" className="text-lg font-bold text-ink">Your referrals</h2>
        {!list.ok ? <Alert tone="danger">{list.error}</Alert> : list.data.length === 0 ? (
          <EmptyState title="No referrals yet" description="Share your link with a supplier or buyer you trust." />
        ) : (
          <ul className="space-y-2">
            {list.data.map((r) => {
              const s = STATUS[r.status];
              return (
                <li key={r.id}>
                  <Card>
                    <CardBody className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-ink">{r.refereeName ?? "A business"}</p>
                        <Badge tone={s.tone}>{s.label}</Badge>
                      </div>
                      <p className="text-xs text-muted">Joined {formatDate(r.createdAt)}{r.qualifyingAction ? ` · ${ACTION[r.qualifyingAction] ?? r.qualifyingAction}` : ""}</p>
                      {r.status === "qualified" && r.holdUntil ? <p className="text-xs text-muted">Reward on {formatDate(r.holdUntil)}, after our safety check.</p> : null}
                      {r.status === "qualified" && r.riskFlags.length ? <p className="text-xs text-warning">Our team is reviewing this referral before releasing credits.</p> : null}
                      {r.status === "rewarded" ? <p className="text-xs text-success">{r.rewardCredits} credits added to both accounts.</p> : null}
                      {r.status === "rejected" && r.rejectedReason ? <p className="text-xs text-danger">Reason: {r.rejectedReason}</p> : null}
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
