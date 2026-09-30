import { useTranslations } from "next-intl";
import type { Kfs } from "@cnote/credit";
import { Money } from "@cnote/ui";

export const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/** Key Fact Statement (RBI digital lending guidelines), shown before the borrower can accept. The lender is named as lender of record. */
export function KfsCard({ kfs, expiresAt, date }: { kfs: Kfs; expiresAt: string; date: (iso: string) => string }) {
  const t = useTranslations("credit");
  const rows: [string, React.ReactNode][] = [
    [t("kfs.lender"), kfs.lenderName],
    [t("kfs.principal"), <Money key="p" paise={kfs.principalPaise} />],
    [t("kfs.tenor"), t("eligible.days", { days: kfs.tenorDays })],
    [t("kfs.interestRate"), pct(kfs.aprBps)],
    [t("kfs.allInApr"), pct(kfs.allInAprBps)],
    [t("kfs.interest"), <Money key="i" paise={kfs.interestPaise} />],
    [t("kfs.processingFee"), <Money key="f" paise={kfs.processingFeePaise} />],
    [t("kfs.otherFees"), <Money key="o" paise={kfs.otherFeesPaise} />],
    [t("kfs.total"), <strong key="t"><Money paise={kfs.totalRepayablePaise} /></strong>],
    [t("kfs.lateFee"), t("kfs.lateFeeValue", { percent: pct(kfs.lateFeeBpsPerMonth) })],
    [t("kfs.coolingOff"), t("kfs.coolingOffValue", { days: kfs.coolingOffDays })],
    [t("kfs.prepayment"), kfs.prepaymentCharge === "none" ? t("kfs.prepaymentNone") : kfs.prepaymentCharge],
    [t("kfs.repayment"), t(`kfs.repayment_${kfs.repayment}`)],
    [t("kfs.grievance"), t("kfs.grievanceValue", { name: kfs.grievanceOfficer.name, email: kfs.grievanceOfficer.email, phone: kfs.grievanceOfficer.phone })],
  ];
  return (
    <section aria-label={t("kfs.heading")} className="rounded-card border border-line p-4">
      <h4 className="text-sm font-semibold text-ink">{t("kfs.heading")}</h4>
      <p className="mt-1 text-sm text-muted">{t("kfs.intro", { lender: kfs.lenderName })}</p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k}><dt className="text-muted">{k}</dt><dd className="font-medium text-ink">{v}</dd></div>
        ))}
      </dl>
      <p className="mt-3 text-sm text-muted">{t("kfs.expires", { date: date(expiresAt) })}</p>
      <p className="mt-1 text-sm text-muted">{t("kfs.cnoteRole")}</p>
    </section>
  );
}
