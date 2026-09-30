"use client";
import type { CandidateView } from "@cnote/enquiry";
import type { ActionResult } from "@cnote/next-kit";
import { Alert, Button, Card, CardBody, TrustBadge } from "@cnote/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { pickSellersAction } from "./actions";
import { trustLabels } from "./trust-labels";

/** ADR-002 option 4: buyer chooses sellers from the ranked list; nothing is offered until they submit. */
export function PickSellersForm({ enquiryId, candidates, max }: { enquiryId: string; candidates: CandidateView[]; max: number }) {
  const t = useTranslations("buyer");
  const tc = useTranslations("cards");
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(pickSellersAction, null);
  const [selected, setSelected] = useState<string[]>([]);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length < max ? [...s, id] : s));

  if (candidates.length === 0) return <Alert tone="warning">{t("pickNone")}</Alert>;
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="enquiryId" value={enquiryId} />
      {state && !state.ok ? <Alert tone="danger">{state.error}</Alert> : null}
      <p className="text-sm text-muted">{t("pickHint", { max })}</p>
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
                      <span className="text-xs text-muted">{c.city ?? t("pickCityFallback")} · {t("pickSuggested", { n: i + 1 })}</span>
                    </span>
                    <TrustBadge tier={c.verificationTier} badgeActive={c.badgeActive} labels={trustLabels(tc)} />
                  </CardBody>
                </label>
              </Card>
            </li>
          );
        })}
      </ul>
      <div>
        <Button type="submit" disabled={pending || selected.length === 0}>
          {pending ? t("sending") : selected.length ? t("pickSend", { count: selected.length }) : t("pickSendNone")}
        </Button>
      </div>
    </form>
  );
}
