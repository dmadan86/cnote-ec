import { verifyUnsubscribeToken } from "@cnote/alerts";
import { Alert, buttonClasses, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getRequestLocale } from "@/lib/request-locale";
import { UnsubscribeForm } from "@/features/retention/unsubscribe-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "retention" });
  // the token is a credential: never indexed, never sent on as a referrer
  return { title: t("unsubscribe.title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/** Public (no session): the signed token in the email link is the credential. Shows what will be switched off, then asks to confirm. */
export default async function UnsubscribeAlertsPage(props: PageProps<"/unsubscribe/alerts">) {
  const sp = await props.searchParams;
  const raw = Array.isArray(sp.t) ? sp.t[0] : sp.t;
  const token = typeof raw === "string" ? raw : "";
  const parsed = token ? verifyUnsubscribeToken(token) : null;
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "retention" });
  return (
    <Container className="flex max-w-xl flex-col gap-6 py-10">
      <PageHeader title={t("unsubscribe.title")} />
      {parsed ? (
        <UnsubscribeForm token={token} type={parsed.type} />
      ) : (
        <div className="flex flex-col gap-4">
          <Alert tone="warning">{t("unsubscribe.invalid")}</Alert>
          <div className="flex flex-wrap gap-2">
            <Link href="/account/alerts" className={buttonClasses("primary", "md", "min-h-11")}>{t("unsubscribe.settings")}</Link>
            <Link href="/" className={buttonClasses("outline", "md", "min-h-11")}>{t("unsubscribe.home")}</Link>
          </div>
        </div>
      )}
    </Container>
  );
}
