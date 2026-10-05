import type { RequestView } from "@cnote/approvals";
import { getPersonSummaries } from "@cnote/identity";
import { Badge, type BadgeTone } from "@cnote/ui";
import { getTranslations } from "next-intl/server";
import { formatDate, type Locale } from "@/i18n/config";

export const STATUS_TONE: Record<RequestView["status"], BadgeTone> = { pending: "warning", approved: "success", rejected: "danger", cancelled: "neutral", expired: "neutral" };

/** Names for a set of person ids (masked email when a person has no name). */
export async function personNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const map = await getPersonSummaries(ids.filter((i): i is string => !!i));
  return new Map([...map].map(([id, p]) => [id, p.name ?? p.email ?? "—"]));
}

export const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

/** The audit trail of approval requests about one subject: who asked, every decision (with delegate and comment), the outcome. */
export async function ApprovalTrail({ requests, locale, headingLevel = 2 }: { requests: RequestView[]; locale: string; headingLevel?: 2 | 3 }) {
  if (requests.length === 0) return null;
  const t = await getTranslations({ locale, namespace: "approvals" });
  const names = await personNames(requests.flatMap((r) => [r.requesterPersonId, ...r.decisions.flatMap((d) => [d.deciderPersonId, d.onBehalfOfPersonId])]));
  const nm = (id: string | null) => (id ? names.get(id) ?? "—" : t("trail.system"));
  const when = (iso: string) => formatDate(iso, locale as Locale, { dateStyle: "medium", timeStyle: "short" });
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby="approval-trail-h" className="rounded-card border border-line bg-surface p-4">
      <H id="approval-trail-h" className="text-base font-semibold text-ink">{t("trail.title")}</H>
      <ol className="mt-3 flex flex-col gap-5">
        {requests.map((r) => (
          <li key={r.id} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={STATUS_TONE[r.status]}>{t(`status.${r.status}`)}</Badge>
              <span className="font-medium text-ink">{t(`actions.${r.action}`)} · {rupees(r.amountPaise)}</span>
              <span className="text-muted">{t("trail.requestedBy", { name: nm(r.requesterPersonId), when: when(r.createdAt) })}</span>
              {r.reason === "spend_limit" ? <Badge tone="brand">{t("trail.overLimit")}</Badge> : null}
            </div>
            <ol className="ms-1 flex flex-col gap-2 border-s border-line ps-4">
              {r.decisions.map((d) => (
                <li key={d.id} className="text-sm">
                  <p className="text-ink">
                    <span className="font-medium">{t("trail.level", { n: d.level })}</span> · {t(`decision.${d.kind}`)}
                    {d.deciderPersonId ? ` · ${nm(d.deciderPersonId)}` : ""}
                    {d.onBehalfOfPersonId ? ` (${t("trail.onBehalf", { name: nm(d.onBehalfOfPersonId) })})` : ""}
                    <span className="text-muted"> · {when(d.createdAt)}</span>
                  </p>
                  {d.comment ? <p className="mt-0.5 whitespace-pre-wrap text-muted">“{d.comment}”</p> : null}
                </li>
              ))}
              {r.status === "pending" ? <li className="text-sm text-muted">{t("trail.waiting", { n: r.currentLevel, total: r.totalLevels })}</li> : null}
            </ol>
          </li>
        ))}
      </ol>
    </section>
  );
}
