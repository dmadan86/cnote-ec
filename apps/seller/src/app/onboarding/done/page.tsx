import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Card, CardBody, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("onboarding.done");
  return { title: t("meta") };
}

export default async function OnboardingDonePage() {
  const session = await requireSeller("/onboarding/done");
  const t = await getTranslations("onboarding.done");
  const tier = session.business.verificationTier;
  const next = [
    { title: t("leads.title"), body: t("leads.body"), href: "/leads", cta: t("leads.cta") },
    ...(tier < 1 ? [{ title: t("gst.title"), body: t("gst.body"), href: "/verification", cta: t("gst.cta") }] : []),
    { title: t("listings.title"), body: t("listings.body"), href: "/listings/new", cta: t("listings.cta") },
  ];
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-1 size-7 shrink-0 text-success" aria-hidden />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">{t("title", { name: session.business.name })}</h1>
          <p className="mt-1 text-sm text-muted">{t("subtitle")}</p>
        </div>
      </div>
      <ul className="space-y-3">
        {next.map((n) => (
          <li key={n.href}>
            <Card>
              <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 className="font-semibold text-ink">{n.title}</h2>
                  <p className="text-sm text-muted">{n.body}</p>
                </div>
                <Link href={n.href} className={buttonClasses("outline-brand", "md", "min-h-11 shrink-0")}>{n.cta}</Link>
              </CardBody>
            </Card>
          </li>
        ))}
      </ul>
      <Link href="/dashboard" className={buttonClasses("primary", "lg")}>{t("dashboard")}</Link>
    </div>
  );
}
