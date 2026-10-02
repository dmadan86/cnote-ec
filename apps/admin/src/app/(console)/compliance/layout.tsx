import { hasPrivilege } from "@cnote/admin";
import { PageHeader } from "@cnote/ui";
import { ComplianceTabs } from "@/features/compliance/tabs";
import { requireStaff } from "@/lib/auth";

export default async function ComplianceLayout({ children }: { children: React.ReactNode }) {
  const { staff } = await requireStaff("/compliance", "compliance.read");
  return (
    <>
      <PageHeader title="Compliance" description="DPDP grievances and data-rights requests, moderation appeals, cookie-consent proof, data retention and data residency (ADR-010)." />
      <ComplianceTabs canViewConsent={hasPrivilege(staff, "compliance.consent")} />
      {children}
    </>
  );
}
