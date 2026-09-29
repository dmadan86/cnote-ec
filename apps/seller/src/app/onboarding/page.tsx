import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Alert, Card, CardBody, cn } from "@cnote/ui";
import { requireSession } from "@cnote/next-kit";
import { load } from "@/lib/safe";
import { billing, catalogue, identity } from "@/lib/services";
import { getOnboardingState, STEPS } from "@/features/onboarding/state";
import { BusinessStep, PhoneStep, PlanStep, SkipButton } from "@/features/onboarding/steps";
import { ImageManager } from "@/features/images/image-manager";
import { CompanyForm } from "@/features/company/company-form";
import { AiDraftBox } from "@/features/listings/ai-draft-box";
import { ListingEditor } from "@/features/listings/listing-editor";

export const metadata: Metadata = { title: "Set up your seller account" };

const COPY: Record<number, { title: string; body: string }> = {
  1: { title: "Tell us about your business", body: "Just the basics. Takes under a minute." },
  2: { title: "Verify your phone", body: "This is your first verification level. It tells buyers you are a real person." },
  3: { title: "Verify your GST", body: "Optional now, and it gives you the GST verified badge." },
  4: { title: "Add your first listing", body: "Describe it the way you would on WhatsApp. AI drafts it, you check it." },
  5: { title: "Plan and permissions", body: "Start free. Choose what we may do with your data." },
};

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  const session = await requireSession("/onboarding");
  const sp = await searchParams;
  const state = await getOnboardingState(session);
  if (state.step === "done") redirect("/dashboard");
  const step = state.step;

  // A buyer-only business cannot become a seller here (one Business = one set of roles for now).
  if (session.business && !session.business.isSeller) {
    return (
      <Alert tone="warning">
        This account already has a buyer business ({session.business.name}). To sell, please sign up for the seller app with a different email address. We will add a way to enable selling on an existing business soon.
      </Alert>
    );
  }

  const c = COPY[step]!;
  let body: React.ReactNode;
  if (step === 1) body = <BusinessStep />;
  else if (step === 2) body = <PhoneStep initialPhone={session.phone ?? ""} />;
  else if (step === 3) {
    body = (
      <div className="space-y-6">
        <CompanyForm mode="onboarding" states={Object.entries(identity.GST_STATES).map(([code, name]) => ({ code, name }))} defaults={{ legalName: session.business?.name }} submitLabel="Save and verify GST" />
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">No GST yet?</p>
          <p className="mt-1 text-sm text-muted">You can skip and start listing. You will show as Unverified (phone only), which buyers trust less, and you may rank lower than GST-verified sellers with similar listings. Verify any time from the Verification page.</p>
          <div className="mt-2"><SkipButton step="gst">I don&apos;t have GST yet, skip for now</SkipButton></div>
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
          <AiDraftBox mode="onboarding" defaultLanguage={session.preferredLanguage} />
        )}
        {s4.draft && draftImages?.ok ? <ImageManager listingId={s4.draft.id} initialImages={draftImages.data} /> : null}
        {!s4.draft && !manual ? <Link href="/onboarding?manual=1" className="inline-flex min-h-11 items-center text-sm font-medium text-brand-700 underline">I prefer to fill in a form</Link> : null}
        <SkipButton step="listing">Add a listing later</SkipButton>
      </div>
    );
  } else {
    const [plans, consents] = await Promise.all([load(() => billing.listPlans()), load(() => identity.getConsents(session.personId))]);
    const list = plans.ok ? plans.data : [];
    body = <PlanStep plans={list} defaultPlan={(list.find((p) => p.monthlyPricePaise === 0) ?? list[0])?.code ?? ""} granted={consents.ok ? consents.data : {}} />;
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Setup progress">
        <p className="text-sm font-medium text-muted">
          Step {step} of {STEPS.length}: <span className="text-ink">{STEPS[step - 1]!.title}</span>
        </p>
        <ol className="mt-2 flex gap-1.5">
          {STEPS.map((s) => (
            <li
              key={s.n}
              aria-current={s.n === step ? "step" : undefined}
              className={cn("h-1.5 flex-1 rounded-full", s.n < step ? "bg-brand-600" : s.n === step ? "bg-brand-500" : "bg-line")}
            >
              <span className="sr-only">{s.title}{s.n < step ? " (done)" : s.n === step ? " (current)" : ""}</span>
            </li>
          ))}
        </ol>
        <p className="mt-2 text-xs text-muted">Each step saves as you go. You can close this page and continue later.</p>
      </nav>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{c.title}</h1>
        <p className="mt-1 text-sm text-muted">{c.body}</p>
      </div>
      <Card>
        <CardBody>{body}</CardBody>
      </Card>
    </div>
  );
}
