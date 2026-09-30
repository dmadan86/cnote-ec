import { Alert, Card, CardBody, CardTitle, buttonClasses } from "@cnote/ui";
import type { EnquiryView } from "@cnote/enquiry";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { IntentScore } from "./intent-score";
import { MatchedSellers } from "./matched-sellers";

/** Shown right after posting: intent score with reasons, then the matched sellers or the held/unmatched state. */
export function RfqResult({ enquiry }: { enquiry: EnquiryView }) {
  const t = useTranslations("buyer");
  const cap = enquiry.sellerCap ?? enquiry.matches[0]?.of ?? 3;
  return (
    <div className="flex flex-col gap-5" aria-live="polite">
      {enquiry.status === "rejected" ? (
        <Alert tone="danger">{t("resultRejected")}</Alert>
      ) : enquiry.status === "review" ? (
        <Alert tone="warning">{t("resultReview")}</Alert>
      ) : enquiry.awaitingPick ? (
        <Alert tone="info">{t("resultPick", { cap })}</Alert>
      ) : enquiry.status === "unmatched" ? (
        <Alert tone="warning">{t("resultUnmatched")}</Alert>
      ) : (
        <Alert tone="success">{t("resultOffered", { count: enquiry.matches.length, cap })}</Alert>
      )}

      {enquiry.intentScore !== null ? (
        <Card>
          <CardBody className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <CardTitle>{t("yourIntent")}</CardTitle>
              <IntentScore score={enquiry.intentScore} />
            </div>
            <p className="text-sm text-muted">{t("intentHelp")}</p>
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
          <h2 className="text-lg font-bold text-ink">{t("matchedSellers")}</h2>
          <MatchedSellers matches={enquiry.matches} />
        </section>
      ) : null}

      <div className="flex gap-2">
        <Link href={`/buyer/enquiries/${enquiry.id}`} className={buttonClasses("primary")}>
          {enquiry.awaitingPick ? t("pickSellers") : t("viewRequirement")}
        </Link>
        <Link href="/rfq/new" className={buttonClasses("outline")}>
          {t("postAnother")}
        </Link>
      </div>
    </div>
  );
}
