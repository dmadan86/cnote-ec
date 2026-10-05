import { previewInvite } from "@cnote/identity";
import { currentSession } from "@cnote/next-kit";
import { Alert, Card, CardBody, CardHeader, CardTitle, Container, PageHeader, buttonClasses } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { AcceptInviteForm } from "@/features/approvals/forms";
import { getRequestLocale } from "@/lib/request-locale";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "approvals" });
  return { title: t("accept.title") };
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Invitation landing page: shows who invited, then the signed-in person accepts. An invalid link looks like any other invalid link. */
export default async function AcceptInvitePage(props: PageProps<"/account/team/accept">) {
  const sp = await props.searchParams;
  const token = first(sp.token) ?? "";
  const t = await getTranslations({ locale: await getRequestLocale(), namespace: "approvals" });
  const invite = await previewInvite(token);
  const session = await currentSession();
  const next = `/account/team/accept?token=${encodeURIComponent(token)}`;
  return (
    <Container className="max-w-xl py-10">
      <PageHeader title={t("accept.title")} />
      <Card className="mt-6">
        <CardHeader><CardTitle>{invite ? t("accept.heading", { business: invite.businessName }) : t("accept.invalidTitle")}</CardTitle></CardHeader>
        <CardBody className="flex flex-col gap-4">
          {!invite || invite.status !== "pending" ? (
            <Alert tone="warning">{invite && invite.status === "expired" ? t("accept.expired") : t("accept.invalid")}</Alert>
          ) : (
            <>
              <p className="text-sm text-ink">{t("accept.body", { role: t(`roles.${invite.role}`), email: invite.email })}</p>
              {session ? (
                <AcceptInviteForm token={token} />
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Link href={`/signin?next=${encodeURIComponent(next)}`} className={buttonClasses("primary")}>{t("accept.signIn")}</Link>
                  <Link href={`/signup?next=${encodeURIComponent(next)}`} className={buttonClasses("outline")}>{t("accept.signUp")}</Link>
                </div>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </Container>
  );
}
