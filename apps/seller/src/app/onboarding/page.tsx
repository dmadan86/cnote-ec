import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Alert, Card, CardBody, cn } from "@cnote/ui";
import { requireSession } from "@cnote/next-kit";
import { load } from "@/lib/safe";
import { billing, catalogue, identity } from "@/lib/services";
import { getOnboardingState, STEPS } from "@/features/onboarding/state";
import { BusinessStep, PhoneStep, PlanStep, SkipButton } from "@/features/onboarding/steps";
import { ImageManager } from "@/features/images/image-manager";
import { CompanyForm } from "@/features/company/company-form";
import { AiDraftAlternatives } from "@/features/ai-draft/ai-draft-alternatives";
import { AiDraftBox } from "@/features/listings/ai-draft-box";
import { ListingEditor } from "@/features/listings/listing-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("onboarding");
  return { title: t("meta") };
}

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const session = await requireSession("/onboarding");
  const t = await getTranslations("onboarding");
  const sp = await searchParams;
  const state = await getOnboardingState(session);
  if (state.step === "done") redirect("/dashboard");
  const step = state.step;

  // A buyer-only business cannot become a seller here (one Business = one set of roles for now).
  if (session.business && !session.business.isSeller) {
    return (
      <Alert tone="warning">
        {t("buyerOnly", { name: session.business.name })}
      </Alert>
    );
  }

  let body: React.ReactNode;
  if (step === 1) body = <BusinessStep />;
  else if (step === 2) body = <PhoneStep initialPhone={session.phone ?? ""} />;
  else if (step === 3) {
    body = (
      <div className="space-y-6">
        <CompanyForm mode="onboarding" states={Object.entries(identity.GST_STATES).map(([code, name]) => ({ code, name }))} defaults={{ legalName: session.business?.name }} submitLabel={t("gst.submit")} />
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">{t("gst.noGstTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("gst.noGstBody")}</p>
          <div className="mt-2"><SkipButton step="gst">{t("gst.skip")}</SkipButton></div>
        </div>
      </div>
    );
  } else if (step === 4) {
    const s4 = state as Extract<typeof state, { step: 4 }>;
    const cats = await load(() => catalogue.listCategories());
    const manual = sp.manual === "1";
    const businessId = session.business?.id;
    const draftImages = s4.draft && businessId ? await load(() => catalogue.listSellerListingImages(businessId, s4.draft!.id)) : null;
    body = (
      <div className="space-y-6">
        {s4.loadError ? <Alert tone="danger">{s4.loadError}</Alert> : null}
        {s4.draft || manual ? (
          cats.ok ? <ListingEditor listing={s4.draft} categories={cats.data.filter((x) => !x.prohibited)} mode="onboarding" defaultLanguage={session.preferredLanguage} /> : <Alert tone="danger">{cats.error}</Alert>
        ) : (
          <>
            <AiDraftBox mode="onboarding" defaultLanguage={session.preferredLanguage} />
            <AiDraftAlternatives mode="onboarding" defaultLanguage={session.preferredLanguage} />
          </>
        )}
        {s4.draft && draftImages?.ok ? <ImageManager listingId={s4.draft.id} initialImages={draftImages.data} /> : null}
        {!s4.draft && !manual ? <Link href="/onboarding?manual=1" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">{t("listing.manual")}</Link> : null}
        <SkipButton step="listing">{t("listing.later")}</SkipButton>
      </div>
    );
  } else {
    const [plans, consents] = await Promise.all([load(() => billing.listPlans()), load(() => identity.getConsents(session.personId))]);
    const list = plans.ok ? plans.data : [];
    body = <PlanStep plans={list} defaultPlan={(list.find((p) => p.monthlyPricePaise === 0) ?? list[0])?.code ?? ""} granted={consents.ok ? consents.data : {}} />;
  }

  return (
    <div className="space-y-6">
      <nav aria-label={t("progressLabel")}>
        <p className="text-sm font-medium text-muted">
          {t("progress", { step, total: STEPS.length })}<span className="text-ink">{t(`steps.s${step}`)}</span>
        </p>
        <ol className="mt-2 flex gap-1.5">
          {STEPS.map((s) => (
            <li
              key={s.n}
              aria-current={s.n === step ? "step" : undefined}
              className={cn("h-1.5 flex-1 rounded-full", s.n < step ? "bg-brand-600" : s.n === step ? "bg-brand-500" : "bg-line")}
            >
              <span className="sr-only">{t(`steps.s${s.n}`)}{s.n < step ? ` ${t("stepDone")}` : s.n === step ? ` ${t("stepCurrent")}` : ""}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted">{t("saveHint")}</p>
      </nav>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{t(`copy.s${step}.title`)}</h1>
        <p className="mt-1 text-sm text-muted">{t(`copy.s${step}.body`)}</p>
      </div>
      <Card>
        <CardBody>{body}</CardBody>
      </Card>
    </div>
  );
}
