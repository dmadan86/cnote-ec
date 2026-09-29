import { AlertTriangle, CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { Alert } from "@cnote/ui";
import type { CompanyResult } from "./actions";

const LABEL: Record<string, string> = {
  status: "GST status", name: "Business name", state: "State", pan: "PAN link", filing: "Return filing", hsn: "Product HSN codes",
};

export function CheckResults({ result }: { result: CompanyResult }) {
  const tone = result.decision === "passed" ? "success" : result.decision === "review" ? "info" : result.decision === "saved" ? "success" : "warning";
  const headline =
    result.decision === "passed" ? "GST verified. Your badge now shows GST verified."
    : result.decision === "review" ? "We saved your details. A person on our team will check a few things and confirm, usually within one working day."
    : result.decision === "unavailable" ? "The GST service is busy right now. Your details are saved. Please try again in a few minutes."
    : result.decision === "saved" ? "Company details saved."
    : "We could not verify this GSTIN.";
  return (
    <div className="space-y-3" aria-live="polite">
      <Alert tone={tone}>{headline}</Alert>
      {result.checks.length > 0 ? (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface text-sm">
          {result.checks.map((c) => (
            <li key={c.id} className="flex gap-3 px-4 py-3">
              {c.result === "pass" ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-label="Passed" />
                : c.result === "fail" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Failed" />
                : c.result === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Needs a look" />
                : <MinusCircle className="mt-0.5 size-4 shrink-0 text-muted" aria-label="Skipped" />}
              <span><span className="font-medium text-ink">{LABEL[c.id] ?? c.id}.</span> <span className="text-muted">{c.detail}</span></span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
