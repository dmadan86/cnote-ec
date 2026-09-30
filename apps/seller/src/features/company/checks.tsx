import { AlertTriangle, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Alert } from "@cnote/ui";
import type { CompanyResult } from "./actions";

const KNOWN_CHECKS = ["status", "name", "state", "pan", "filing", "hsn"];

export function CheckResults({ result }: { result: CompanyResult }) {
  const t = useTranslations("settings.company.checks");
  const tone = result.decision === "passed" ? "success" : result.decision === "review" ? "info" : result.decision === "saved" ? "success" : "warning";
  // The `detail` text of each check comes from the identity module (domain messages stay as they are).
  return (
    <div className="space-y-3" aria-live="polite">
      <Alert tone={tone}>{t(`headline.${result.decision}`)}</Alert>
      {result.checks.length > 0 ? (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface text-sm">
          {result.checks.map((c) => (
            <li key={c.id} className="flex gap-3 px-4 py-3">
              {c.result === "pass" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label={t("passed")} />
                : c.result === "fail" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label={t("failed")} />
                : c.result === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label={t("warn")} />
                : <MinusCircle className="mt-0.5 size-4 shrink-0 text-muted" aria-label={t("skipped")} />}
              <span><span className="font-medium text-ink">{KNOWN_CHECKS.includes(c.id) ? t(`labels.${c.id}`) : c.id}.</span> <span className="text-muted">{c.detail}</span></span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
