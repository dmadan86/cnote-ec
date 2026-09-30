import { getLocale, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle } from "@cnote/ui";
import { getDraftForMatch, isQuoteAssistEnabled, listAgentActions } from "@cnote/negotiation";
import { isLocale } from "@/i18n/config";
import { formatDate } from "@/lib/format";
import { AssistantLog } from "./assistant-log";
import { DraftCard, RequestDraft } from "./draft-card";

/**
 * ADR-014 seller quote assist on the conversation page. Mount: `<QuoteAssistPanel matchId={c.matchId} conversationId={c.id} sellerBusinessId={session.business.id} />`.
 * Renders nothing while QUOTE_ASSIST_ENABLED is off.
 */
export async function QuoteAssistPanel({ matchId, conversationId, sellerBusinessId }: { matchId: string; conversationId: string; sellerBusinessId: string }) {
  if (!isQuoteAssistEnabled()) return null;
  const t = await getTranslations("negotiation.panel");
  const loc = await getLocale();
  const locale = isLocale(loc) ? loc : "en";
  let draft, thisLeadLog;
  try {
    draft = await getDraftForMatch(sellerBusinessId, matchId);
    const lists = await Promise.all([listAgentActions(sellerBusinessId, { subjectId: matchId, limit: 10 }), draft ? listAgentActions(sellerBusinessId, { subjectId: draft.id, limit: 10 }) : []]);
    thisLeadLog = lists.flat().sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  } catch (err) {
    console.error("[seller] quote assist failed to load", err);
    return <Alert tone="warning">{t("unavailable")}</Alert>;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        {draft ? <Badge tone={draft.status === "pending" ? "brand" : draft.status === "approved" ? "success" : "neutral"}>{draft.status === "pending" ? t("draftReady") : draft.status === "approved" ? t("approvedSent") : t("discarded")}</Badge> : null}
      </CardHeader>
      <CardBody className="space-y-5">
        {!draft ? <RequestDraft matchId={matchId} conversationId={conversationId} /> : draft.status === "pending" ? (
          <DraftCard
            d={{
              id: draft.id, conversationId, matchId, priceRupees: draft.pricePaise / 100, quantity: draft.quantity, unit: draft.unit, leadTimeDays: draft.leadTimeDays, validUntil: draft.validUntil,
              notes: draft.notes ?? "", rationale: draft.rationale, confidence: draft.confidence, needsReview: draft.needsReview, modelPriceRejected: draft.boundsCheck.modelPriceRejected,
              floorRupees: draft.boundsCheck.floorPaise == null ? null : draft.boundsCheck.floorPaise / 100,
            }}
          />
        ) : (
          <p className="text-sm text-muted">{draft.status === "approved" ? (draft.validUntil ? t("approvedNoteValid", { date: formatDate(draft.validUntil, locale) }) : t("approvedNote")) : t("discardedNote")}</p>
        )}
        <section aria-labelledby="qa-log-h" className="space-y-2">
          <h3 id="qa-log-h" className="text-sm font-semibold text-ink">{t("logHeading")}</h3>
          <AssistantLog actions={thisLeadLog} />
        </section>
      </CardBody>
    </Card>
  );
}
