import { Alert, Card, CardBody, CardTitle, IntentScore, buttonClasses } from "@cnote/ui";
import type { EnquiryView } from "@cnote/enquiry";
import Link from "next/link";
import { MatchedSellers } from "./matched-sellers";

/** Shown right after posting: intent score with reasons, then the matched sellers or the held/unmatched state. */
export function RfqResult({ enquiry }: { enquiry: EnquiryView }) {
  const cap = enquiry.sellerCap ?? enquiry.matches[0]?.of ?? 3;
  return (
    <div className="flex flex-col gap-5" aria-live="polite">
      {enquiry.status === "rejected" ? (
        <Alert tone="danger">
          We could not accept this requirement because it may go against our marketplace rules. Please review it and try again.
        </Alert>
      ) : enquiry.status === "review" ? (
        <Alert tone="warning">
          Your requirement is held for a quick human check so sellers only see genuine requests. This usually takes a short while and we will
          match sellers as soon as it is approved.
        </Alert>
      ) : enquiry.awaitingPick ? (
        <Alert tone="info">Requirement posted. You chose to pick sellers yourself, so choose up to {cap} from the ranked list.</Alert>
      ) : enquiry.status === "unmatched" ? (
        <Alert tone="warning">Requirement posted, but we could not find a matching seller yet. Try adding more detail or a category.</Alert>
      ) : (
        <Alert tone="success">
          Requirement posted and offered to {enquiry.matches.length} of up to {cap} sellers. Each seller has 2 hours to reply, and your
          requirement is never broadcast to more than {cap}.
        </Alert>
      )}

      {enquiry.intentScore !== null ? (
        <Card>
          <CardBody className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <CardTitle>Your intent score</CardTitle>
              <IntentScore score={enquiry.intentScore} />
            </div>
            <p className="text-sm text-muted">Sellers see this score. A specific quantity, location and timeline raise it.</p>
            {enquiry.intentReasons.length ? (
              <ul className="list-disc pl-5 text-sm text-ink">
                {enquiry.intentReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {enquiry.matches.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-bold text-ink">Matched sellers</h2>
          <MatchedSellers matches={enquiry.matches} />
        </section>
      ) : null}

      <div className="flex gap-2">
        <Link href={`/buyer/enquiries/${enquiry.id}`} className={buttonClasses("primary")}>
          {enquiry.awaitingPick ? "Pick sellers" : "View requirement"}
        </Link>
        <Link href="/rfq/new" className={buttonClasses("outline")}>
          Post another
        </Link>
      </div>
    </div>
  );
}
