import { Badge, Card, CardBody, TrustBadge } from "@cnote/ui";
import type { MatchView } from "@cnote/enquiry";
import Link from "next/link";
import { MatchStatusBadge } from "./status";

/** Buyer-facing list of the sellers this requirement was offered to, with their real trust tier (ADR-003). */
export function MatchedSellers({ matches }: { matches: MatchView[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {matches.map((m) => (
        <li key={m.id}>
          <Card>
            <CardBody className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{m.sellerName}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {m.seller ? <TrustBadge tier={m.seller.verificationTier} badgeActive={m.seller.badgeActive} /> : null}
                  {m.seller?.city ? <span>{m.seller.city}</span> : null}
                  <Badge tone="brand">Seller {m.rank} of {m.of}</Badge>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <MatchStatusBadge status={m.status} />
                {m.conversationId ? (
                  <Link href={`/conversations/${m.conversationId}`} className="text-sm font-semibold text-brand-700 hover:underline">
                    Open chat
                  </Link>
                ) : null}
              </div>
            </CardBody>
          </Card>
        </li>
      ))}
    </ul>
  );
}
