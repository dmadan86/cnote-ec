import type { Metadata } from "next";
import { getFormatter, getTranslations } from "next-intl/server";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, PageHeader } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";
import { load } from "@/lib/safe";
import { identity } from "@/lib/services";
import { CompanyForm } from "@/features/company/company-form";
import { MsmeForm } from "@/features/purchase-orders/forms";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("settings.company");
  return { title: t("meta") };
}

const STATES = Object.entries(identity.GST_STATES).map(([code, name]) => ({ code, name }));

export default async function CompanyPage() {
  const session = await requireSeller("/settings/company");
  const t = await getTranslations("settings.company");
  const f = await getFormatter();
  const when = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const res = await load(() => identity.getCompanyProfile(session.business.id));
  const p = res.ok ? res.data : null;
  const tm = await getTranslations("purchaseOrders.msme");
  const msme = await load(() => identity.getMsmeStatus(session.business.id));
  const gstTone = p?.gstStatus === "Active" ? "success" : p?.gstStatus ? "danger" : "neutral";
  return (
    <div className="max-w-2xl space-y-6">
      <PageHeader title={t("title")} description={t("description")} />
      {!res.ok ? <Alert tone="danger">{res.error}</Alert> : null}
      {p?.gstStatus && p.gstStatus !== "Active" ? <Alert tone="warning">{t("gstWarn", { status: p.gstStatus.toLowerCase() })}</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>{t("gstCard")}</CardTitle>
          <Badge tone={gstTone}>{p?.gstStatus ?? t("notVerified")}</Badge>
        </CardHeader>
        <CardBody className="text-sm text-muted">
          {p?.gstin ? <p>{t.rich("gstinLine", { gstin: p.gstin, mono: (c) => <span className="font-mono text-ink">{c}</span> })}</p> : <p>{t("noGstin")}</p>}
          {p?.gstVerifiedAt ? <p>{t("verifiedAt", { date: when(p.gstVerifiedAt) })}</p> : null}
          {p?.gstLastCheckedAt ? <p>{t("lastChecked", { date: when(p.gstLastCheckedAt) })}</p> : null}
        </CardBody>
      </Card>
      {msme.ok && msme.data ? (
        <Card>
          <CardHeader><CardTitle>{tm("title")}</CardTitle></CardHeader>
          <CardBody><MsmeForm category={msme.data.category} udyamOnFile={msme.data.udyamOnFile} covered={msme.data.covered} /></CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>{t("details")}</CardTitle></CardHeader>
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
