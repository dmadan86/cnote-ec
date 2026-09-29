import type { Metadata } from "next";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { load } from "@/lib/safe";
import { identity } from "@/lib/services";
import { CompanyForm } from "@/features/company/company-form";

export const metadata: Metadata = { title: "Company profile" };

const STATES = Object.entries(identity.GST_STATES).map(([code, name]) => ({ code, name }));

export default async function CompanyPage() {
  const session = await requireSeller("/settings/company");
  const res = await load(() => identity.getCompanyProfile(session.business.id));
  const p = res.ok ? res.data : null;
  const gstTone = p?.gstStatus === "Active" ? "success" : p?.gstStatus ? "danger" : "neutral";
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title="Company profile" description="Your legal details, checked against the GST registry. Buyers see only your verified badge, never your PAN." />
      {!res.ok ? <Alert tone="danger">{res.error}</Alert> : null}
      {p?.gstStatus && p.gstStatus !== "Active" ? <Alert tone="warning">Your GSTIN is {p.gstStatus.toLowerCase()} on the GST portal, so your GST verified badge is off. Fix it with your GST officer, then save below to re-check.</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>GST status</CardTitle>
          <Badge tone={gstTone}>{p?.gstStatus ?? "Not verified"}</Badge>
        </CardHeader>
        <CardBody className="text-sm text-muted">
          {p?.gstin ? <p>GSTIN <span className="font-mono text-ink">{p.gstin}</span></p> : <p>No GSTIN verified yet.</p>}
          {p?.gstVerifiedAt ? <p>Verified {formatDateTime(p.gstVerifiedAt)}</p> : null}
          {p?.gstLastCheckedAt ? <p>Last checked {formatDateTime(p.gstLastCheckedAt)}. We re-check about once a month.</p> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>Details</CardTitle></CardHeader>
        <CardBody>
          <CompanyForm
            mode="portal"
            states={STATES}
            defaults={{
              legalName: p?.legalName ?? session.business.name, tradeName: p?.tradeName, companyType: p?.companyType, cin: p?.cin,
              panMasked: p?.panMasked, gstin: p?.gstin, website: p?.website,
              line1: p?.registeredAddress?.line1, line2: p?.registeredAddress?.line2, city: p?.registeredAddress?.city,
              stateCode: p?.registeredAddress?.stateCode, pincode: p?.registeredAddress?.pincode,
            }}
          />
        </CardBody>
      </Card>
    </div>
  );
}
