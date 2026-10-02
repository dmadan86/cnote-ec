import { verifyGrievanceContact } from "@cnote/compliance";
import { Alert, Container, PageHeader } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { getRequestLocale } from "@/lib/request-locale";

// The signed link in the data-request confirmation email lands here. The token is in the URL, so: never indexed, no Referer
// (see NO_REFERRER_PATHS in @cnote/next-kit/security), and always rendered per request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grievance" });
  return { title: t("verifyTitle"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function VerifyGrievancePage({ searchParams }: PageProps<"/grievance/verify">) {
  const sp = await searchParams;
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "grievance" });
  let ok = false;
  try {
    ok = (await verifyGrievanceContact(first(sp.ticket), first(sp.token))).verified;
  } catch {
    ok = false; // wrong, forged or expired link: one generic message
  }
  return (
    <Container className="flex flex-col gap-6 py-8">
      <PageHeader title={t("verifyTitle")} />
      {ok ? <Alert tone="success">{t("verifyDone")}</Alert> : <Alert tone="danger">{t("verifyInvalid")}</Alert>}
      <p className="text-sm">
        <Link className="text-brand-700 underline" href="/">
          {t("verifyHome")}
        </Link>
      </p>
    </Container>
  );
}
