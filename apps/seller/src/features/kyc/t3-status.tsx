import { Alert, Badge } from "@cnote/ui";
import type { AuditView } from "@cnote/identity";
import { formatDate } from "@/lib/format";

/** Seller-facing T3 status. Findings and reports are staff-only, so only status, dates and result show here. */
export function T3Status({ audit, tier }: { audit: Pick<AuditView, "status" | "partner" | "scheduledFor" | "result" | "validUntil"> | null; tier: number }) {
  if (!audit) return <p className="text-sm text-muted">{tier < 2 ? "Available after KYC. " : ""}Only categories that need it are audited. If yours does, our team will contact you.</p>;
  if (audit.status === "requested") return <Alert tone="info">An audit by {audit.partner} has been requested. We will confirm a date with you.</Alert>;
  if (audit.status === "scheduled") return <Alert tone="info">Audit by {audit.partner} scheduled for {audit.scheduledFor ? formatDate(audit.scheduledFor) : "a date to be confirmed"}. Keep your premises and stock records ready.</Alert>;
  if (audit.status === "completed" && audit.result === "pass") return <p className="text-sm text-muted"><Badge tone="success">Passed</Badge> Valid until {audit.validUntil ? formatDate(audit.validUntil) : "further notice"}.</p>;
  if (audit.status === "completed") return <p className="text-sm text-muted"><Badge tone="warning">Conditional</Badge> Our team will follow up on the open points.</p>;
  if (audit.status === "expired") return <p className="text-sm text-muted"><Badge>Expired</Badge> Your last audit lapsed{audit.validUntil ? ` on ${formatDate(audit.validUntil)}` : ""}. Contact support to renew.</p>;
  if (audit.status === "failed") return <p className="text-sm text-muted"><Badge tone="danger">Not passed</Badge> Contact support to discuss next steps.</p>;
  return null;
}
