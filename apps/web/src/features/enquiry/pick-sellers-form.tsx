"use client";
import type { CandidateView } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Card, CardBody, TrustBadge } from "@cnote/ui";
import { useActionState, useState } from "react";
import { pickSellersAction } from "./actions";

/** ADR-002 option 4: buyer chooses sellers from the ranked list; nothing is offered until they submit. */
export function PickSellersForm({ enquiryId, candidates, max }: { enquiryId: string; candidates: CandidateView[]; max: number }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(pickSellersAction, null);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < max ? [...s, id] : s));

  if (candidates.length === 0) return <Alert tone="warning">No more sellers available to pick right now.</Alert>;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="enquiryId" value={enquiryId} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      <p className="text-sm text-muted">Choose up to {max} seller{max === 1 ? "" : "s"}. Ranked by relevance and trust, never by paid plan.</p>
      <ul className="flex flex-col gap-2">
        {candidates.map((c, i) => {
          const on = selected.includes(c.sellerBusinessId);
          return (
            <li key={c.sellerBusinessId}>
              <Card className={on ? "border-brand-600 bg-brand-50" : undefined}>
                <label className="flex cursor-pointer items-center gap-3 p-4">
                  <input
                    type="checkbox"
                    name="sellerId"
                    value={c.sellerBusinessId}
                    checked={on}
                    onChange={() => toggle(c.sellerBusinessId)}
                    className="size-4 accent-brand-600"
                  />
                  <CardBody className="flex flex-1 flex-wrap items-center justify-between gap-2 p-0">
                    <span>
                      <span className="block font-semibold text-ink">{c.sellerName}</span>
                      <span className="text-xs text-muted">{c.city ?? "India"} · Suggested #{i + 1}</span>
                    </span>
                    <TrustBadge tier={c.verificationTier} badgeActive={c.badgeActive} />
                  </CardBody>
                </label>
              </Card>
            </li>
          );
        })}
      </ul>
      <div>
        <Button type="submit" disabled={pending || selected.length === 0}>
          {pending ? "Sending…" : `Send to ${selected.length || ""} seller${selected.length === 1 ? "" : "s"}`.replace("  ", " ")}
        </Button>
      </div>
    </form>
  );
}
