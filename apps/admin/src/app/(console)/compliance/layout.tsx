import { PageHeader } from "@cnote/ui";
import { ComplianceTabs } from "@/features/compliance/tabs";
import { requireStaff } from "@/lib/auth";

export default async function ComplianceLayout({ children }: { children: React.ReactNode }) {
  await requireStaff("/compliance", "compliance.read");
  return (
    <>
      <PageHeader title="Compliance" description="DPDP grievances, moderation appeals, data retention and data residency (ADR-010)." />
      <ComplianceTabs />
      {children}
    </>
  );
}
