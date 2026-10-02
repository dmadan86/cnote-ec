import { getBuyerBusinessProfile, listAddresses } from "@cnote/identity";
import { requireSession } from "@cnote/next-kit";
import { Alert, Badge, Card, CardBody, CardHeader, CardTitle, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AddressManager, GstinForm } from "@/features/account/business-forms";
import { stateLabel } from "@/features/identity/states";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "account2" });
  return { title: t("title") };
}

export default async function BusinessProfilePage() {
  const s = await requireSession("/account/business");
  const locale = await getRequestLocale();
  const [t, ts] = await Promise.all([getTranslations({ locale, namespace: "account2" }), getTranslations({ locale, namespace: "states" })]);
  const [profile, addresses] = s.business ? await Promise.all([getBuyerBusinessProfile(s.business.id), listAddresses(s.business.id)]) : [null, []];
  const verified = !!profile?.gstin && !!profile.gstVerifiedAt;
  const stateText = (name: string | null) => (name ? stateLabel(name, (c) => (ts.has(c) ? ts(c) : undefined)) : "");

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader
        title={t("title")}
        description={s.business ? s.business.name : t("subtitle")}
        actions={<Link href="/account" className={buttonClasses("outline", "md")}>{t("backToAccount")}</Link>}
      />
      {!s.business ? (
        <Alert tone="info">{t("noBusiness")}</Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t("gstinTitle")}</CardTitle>
              {verified ? <Badge tone="success">{t("gstinVerified")}</Badge> : <Badge>{t("notVerified")}</Badge>}
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
              <p className="text-sm text-muted">{t("gstinBody")}</p>
              {verified && profile ? (
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">{t("gstinLabel")}</dt>
                  <dd className="font-medium text-ink">{profile.gstin}</dd>
                  <dt className="text-muted">{t("legalName")}</dt>
                  <dd className="font-medium text-ink">{profile.legalName}</dd>
                  <dt className="text-muted">{t("gstState")}</dt>
                  <dd className="font-medium text-ink">{stateText(profile.gstState)}</dd>
                  <dt className="text-muted">{t("gstStatus")}</dt>
                  <dd className="font-medium text-ink">{profile.gstStatus}</dd>
                  <dt className="text-muted">{t("verifiedOn")}</dt>
                  <dd className="font-medium text-ink">{formatDate(profile.gstVerifiedAt!, locale, { dateStyle: "medium" })}</dd>
                  <dt className="text-muted">{t("tier")}</dt>
                  <dd className="font-medium text-ink">{t("tierValue", { tier: profile.verificationTier })}</dd>
                </dl>
              ) : null}
              <GstinForm gstin={profile?.gstin ?? null} verified={verified} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("addressesTitle")}</CardTitle></CardHeader>
            <CardBody className="flex flex-col gap-4">
              <p className="text-sm text-muted">{t("addressesBody")}</p>
              <AddressManager addresses={addresses.map((a) => ({ id: a.id, label: a.label, contactName: a.contactName, phone: a.phone, line1: a.line1, line2: a.line2, city: a.city, state: a.state, pincode: a.pincode, isDefault: a.isDefault }))} />
            </CardBody>
          </Card>
        </div>
      )}
    </Container>
  );
}
