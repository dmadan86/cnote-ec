import { Card, CardBody, Container } from "@cnote/ui";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { confirmReachabilityAction } from "./actions";

// Public, no login. The GET only renders; confirming is a POST (server action) so prefetchers cannot auto-confirm.
export const metadata: Metadata = { title: "Confirm your requirement", robots: { index: false, follow: false } };

type Props = { params: Promise<{ token: string }>; searchParams: Promise<{ s?: string; l?: string }> };

export default async function ReachabilityPage({ params, searchParams }: Props) {
  const [{ token }, sp] = await Promise.all([params, searchParams]);
  const locale = sp.l === "hi" ? "hi" : "en";
  const t = await getTranslations({ locale, namespace: "reachability" });
  const state = sp.s === "responded" ? "done" : sp.s === "expired" || sp.s === "not_found" ? "expired" : "ask";
  return (
    <Container className="flex max-w-xl flex-col gap-4 py-10">
      <main lang={locale}>
        <Card>
          <CardBody className="flex flex-col gap-4">
            <h1 className="text-xl font-semibold text-ink">{state === "done" ? t("thanksTitle") : state === "expired" ? t("expiredTitle") : t("heading")}</h1>
            <p role={state === "ask" ? undefined : "status"} className="text-base text-ink">
              {state === "done" ? t("thanksBody") : state === "expired" ? t("expiredBody") : t("intro")}
            </p>
            {state === "ask" ? (
              <form action={confirmReachabilityAction}>
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="lang" value={locale} />
                <button type="submit" className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-brand-700 px-5 py-3 text-base font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-700 sm:w-auto">
                  {t("confirm")}
                </button>
              </form>
            ) : null}
          </CardBody>
        </Card>
      </main>
      <nav aria-label="Language" className="flex gap-4 text-sm">
        <a lang="en" hrefLang="en" className="min-h-11 py-2 text-brand-700 underline" href={`/r/${encodeURIComponent(token)}${sp.s ? `?s=${encodeURIComponent(sp.s)}&l=en` : "?l=en"}`}>English</a>
        <a lang="hi" hrefLang="hi" className="min-h-11 py-2 text-brand-700 underline" href={`/r/${encodeURIComponent(token)}${sp.s ? `?s=${encodeURIComponent(sp.s)}&l=hi` : "?l=hi"}`}>हिन्दी</a>
      </nav>
    </Container>
  );
}
