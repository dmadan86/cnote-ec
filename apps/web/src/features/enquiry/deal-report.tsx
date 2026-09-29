"use client";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Card, CardBody, CardTitle } from "@cnote/ui";
import { useActionState } from "react";
import { reportDealAction } from "./actions";

const LABEL = { won: "Yes, deal done", lost: "No, it fell through", pending: "Still talking" } as const;

/** One-tap "Did this deal close?" (ADR-007). Deals close off-platform in Phase 1; this keeps the event log honest. */
export function DealReport({ conversationId, matchId, current }: { conversationId: string; matchId: string; current: "won" | "lost" | "pending" | null }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(reportDealAction, null);
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <CardTitle>Did this deal close?</CardTitle>
        {current ? <p className="text-sm text-muted">Last answer: <strong className="text-ink">{LABEL[current]}</strong>. You can update it any time.</p> : null}
        {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
        <form action={action} className="flex flex-wrap gap-2">
          <input type="hidden" name="conversationId" value={conversationId} />
          <input type="hidden" name="matchId" value={matchId} />
          {(Object.keys(LABEL) as (keyof typeof LABEL)[]).map((o) => (
            <Button key={o} type="submit" name="outcome" value={o} variant={current === o ? "primary" : "outline"} size="sm" disabled={pending}>
              {LABEL[o]}
            </Button>
          ))}
        </form>
      </CardBody>
    </Card>
  );
}
