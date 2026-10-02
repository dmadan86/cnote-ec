"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Card, CardBody, CardTitle } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { reportDealAction } from "./actions";

const OUTCOMES = ["won", "lost", "pending"] as const;

/** One-tap "Did this deal close?" (ADR-007). Deals close off-platform in Phase 1; this keeps the event log honest. */
export function DealReport({ conversationId, matchId, current, sellerClaimedWon = false }: { conversationId: string; matchId: string; current: "won" | "lost" | "pending" | null; sellerClaimedWon?: boolean }) {
  const t = useTranslations("buyer");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(reportDealAction, null);
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <CardTitle>{t("dealTitle")}</CardTitle>
        {sellerClaimedWon && current !== "won" ? <Alert tone="info">{t("dealSellerClaimed")}</Alert> : null}
        {current ? <p className="text-sm text-muted">{t.rich("dealLast", { answer: t(`deal.${current}`), strong: (c) => <strong className="text-ink">{c}</strong> })}</p> : null}
        {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        <form action={action} className="flex flex-wrap gap-2">
          <input type="hidden" name="conversationId" value={conversationId} />
          <input type="hidden" name="matchId" value={matchId} />
          {OUTCOMES.map((o) => (
            <Button key={o} type="submit" name="outcome" value={o} variant={current === o ? "primary" : "outline"} size="sm" disabled={pending}>
              {t(`deal.${o}`)}
            </Button>
          ))}
        </form>
      </CardBody>
    </Card>
  );
}
