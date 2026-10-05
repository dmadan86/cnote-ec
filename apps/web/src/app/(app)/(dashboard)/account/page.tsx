import { getConsents, listAuthSessions } from "@cnote/identity";
import { requireSession, signOutAction } from "@cnote/next-kit";
import Link from "next/link";
import { Badge, Button, buttonClasses, Card, CardBody, CardHeader, CardTitle, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { CookieSettingsButton } from "@/features/consent";
import { ConsentForm, DeleteAccountForm, PhoneVerification, ProfileForm } from "@/features/identity/forms";
import { signOutEverywhereAction } from "@/features/identity/actions";
import { formatDate } from "@/i18n/config";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "account" });
  return { title: t("title") };
}

export default async function AccountPage() {
  const s = await requireSession("/account");
  const locale = await getRequestLocale();
  const [t, t2, tc, tn, consents, sessions] = await Promise.all([getTranslations({ locale, namespace: "account" }), getTranslations({ locale, namespace: "account2" }), getTranslations({ locale, namespace: "consent" }), getTranslations({ locale, namespace: "nominee" }), getConsents(s.personId), listAuthSessions(s.personId, s.sessionId, "web")]);
  const when = (iso: string) => formatDate(iso, locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("title")} description={s.business ? s.business.name : t("subtitle")} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t("profile")}</CardTitle></CardHeader>
          <CardBody><ProfileForm name={s.name} preferredLanguage={s.preferredLanguage} email={s.email} /></CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t2("businessNavTitle")}</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t2("businessNavBody")}</p>
            <Link href="/account/business" className={buttonClasses("outline", "md", "self-start")}>{t2("businessNavLink")}</Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("phoneTitle")}</CardTitle>{s.phoneVerified ? <Badge tone="success">{t("verified")}</Badge> : <Badge>{t("notVerified")}</Badge>}</CardHeader>
          <CardBody><PhoneVerification phone={s.phone} verified={s.phoneVerified} /></CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("privacyTitle")}</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-4">
            <ConsentForm consents={consents} />
            <div className="border-t border-line pt-4">
              <p className="text-sm text-muted">{tc("accountBody")}</p>
              <CookieSettingsButton label={tc("openSettings")} className={`${buttonClasses("outline", "md", "min-h-11")} mt-2`} />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("sessionsTitle")}</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-4">
            <ul className="divide-y divide-line text-sm">
              {sessions.map((x) => (
                <li key={x.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="line-clamp-1 font-medium text-ink">{x.userAgent ?? t("unknownDevice")}</p>
                    <p className="text-xs text-muted">{t("sessionMeta", { ip: x.ip ?? t("ipUnknown"), when: when(x.lastUsedAt) })}</p>
                  </div>
                  {x.current ? <Badge tone="brand">{t("thisDevice")}</Badge> : null}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <form action={signOutAction}><Button type="submit" variant="outline">{t("signOut")}</Button></form>
              <form action={signOutEverywhereAction}><Button type="submit" variant="outline">{t("signOutEverywhere")}</Button></form>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t("downloadTitle")}</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-sm text-muted">{t("downloadBody")}</p>
            {/* Plain anchor: /account/export is a route handler returning a file, so client-side <Link> navigation would break the download. */}
            <a href="/account/export" download className={buttonClasses("outline", "md", "self-start")}>{t("downloadButton")}</a>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle>{tn("navTitle")}</CardTitle></CardHeader>
          <CardBody className="flex flex-col gap-3">
            <p className="text-sm text-muted">{tn("navBody")}</p>
            <Link href="/account/nominee" className={buttonClasses("outline", "md", "self-start")}>{tn("navLink")}</Link>
          </CardBody>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-danger">{t("deleteTitle")}</CardTitle></CardHeader>
          <CardBody><DeleteAccountForm /></CardBody>
        </Card>
      </div>
    </Container>
  );
}
