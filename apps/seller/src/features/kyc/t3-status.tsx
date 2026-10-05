import { useFormatter, useTranslations } from "next-intl";
import { Alert, Badge } from "@cnote/ui";
import type { AuditView } from "@cnote/identity";

/** Seller-facing T3 status. Findings and reports are staff-only, so only status, dates and result show here. */
export function T3Status({ audit, tier }: { audit: Pick<AuditView, "status" | "partner" | "scheduledFor" | "result" | "validUntil"> & { reAuditDueAt?: string | null } | null; tier: number }) {
  const t = useTranslations("verification.t3");
  const f = useFormatter();
  const date = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "medium" });
  if (!audit) return <p className="text-sm text-muted">{tier < 2 ? t("afterKyc") : ""}{t("none")}</p>;
  if (audit.status === "requested") return <Alert tone="info">{t("requested", { partner: audit.partner })}</Alert>;
  if (audit.status === "scheduled") return <Alert tone="info">{audit.scheduledFor ? t("scheduled", { partner: audit.partner, date: date(audit.scheduledFor) }) : t("scheduledTbc", { partner: audit.partner })}</Alert>;
  if (audit.status === "submitted") return <Alert tone="info">{t("submitted", { partner: audit.partner })}</Alert>;
  if (audit.status === "completed" && audit.result === "pass") {
    const due = audit.reAuditDueAt && new Date(audit.reAuditDueAt).getTime() <= Date.now() && audit.validUntil;
    return (
      <div className="space-y-2 text-sm text-muted">
        <p><Badge tone="success">{t("passed")}</Badge> {audit.validUntil ? t("validUntil", { date: date(audit.validUntil) }) : t("validFurther")}</p>
        {due ? <Alert tone="warning">{t("reaudit", { date: date(audit.validUntil!) })}</Alert> : null}
      </div>
    );
  }
  if (audit.status === "completed") return <p className="text-sm text-muted"><Badge tone="warning">{t("conditional")}</Badge> {t("conditionalBody")}</p>;
  if (audit.status === "expired") return <p className="text-sm text-muted"><Badge>{t("expired")}</Badge> {audit.validUntil ? t("expiredOn", { date: date(audit.validUntil) }) : t("expiredBody")}</p>;
  if (audit.status === "failed") return <p className="text-sm text-muted"><Badge tone="danger">{t("failed")}</Badge> {t("failedBody")}</p>;
  return null;
}
