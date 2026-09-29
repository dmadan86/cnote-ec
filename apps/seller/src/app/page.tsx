import Link from "next/link";
import { ArrowRight, BadgeCheck, Gauge, Handshake, RefreshCcw, Sparkles, Users } from "lucide-react";
import { buttonClasses, Card, CardBody, Container, Money } from "@cnote/ui";
import { load } from "@/lib/safe";
import { Logo } from "@/features/shell/logo";
import { billing, currentSessionSafe } from "@/lib/services";

const VALUE = [
  { icon: Users, title: "3 sellers per lead, at most", body: "Every enquiry goes to a small, capped group instead of everyone in the category. No price wars with ten strangers." },
  { icon: Gauge, title: "See intent before you spend", body: "Each lead shows a 0-100 intent score with the reasons, and your rank among the sellers who received it." },
  { icon: RefreshCcw, title: "Auto-refund, no ticket", body: "Buyer unreachable or fake? Report it within 72 hours and your credit is returned automatically." },
  { icon: BadgeCheck, title: "Badge is earned, never bought", body: "Verification comes from your GST and your track record. Paying more never changes your badge or your rank." },
  { icon: Handshake, title: "No field sales", body: "Plans and prices are public and self-serve. Nobody will call to upsell you, and nothing renews on its own." },
  { icon: Sparkles, title: "List by describing it", body: "Tell us what you sell in Hindi, Hinglish or English, like a WhatsApp message. We draft the listing, you check it." },
];

const STEPS = [
  { n: "1", title: "Tell us about your business", body: "Name, city and a phone OTP. GST can wait." },
  { n: "2", title: "Describe what you sell", body: "Type it like you would tell a buyer. AI drafts the listing and you approve it." },
  { n: "3", title: "Accept the leads you want", body: "Pay one credit only when you accept. Decline the rest for free." },
];

export default async function LandingPage() {
  const [plans, session] = await Promise.all([load(() => billing.listPlans()), currentSessionSafe()]);
  const signedIn = Boolean(session);
  const cta = signedIn ? { href: "/dashboard", label: "Go to dashboard" } : { href: "/signup", label: "Start selling, free" };

  return (
    <div className="bg-canvas">
      <header className="border-b border-line bg-surface">
        <Container className="flex h-16 items-center justify-between">
          <Logo />
          <nav aria-label="Account" className="flex items-center gap-2">
            {signedIn ? null : (
              <Link href="/signin" className={buttonClasses("ghost", "md", "min-h-11")}>
                Sign in
              </Link>
            )}
            <Link href={cta.href} className={buttonClasses("primary", "md", "min-h-11")}>
              {signedIn ? cta.label : "Join for Free"}
            </Link>
          </nav>
        </Container>
      </header>

      <main>
        <section className="bg-linear-to-b from-brand-50 to-canvas">
          <Container className="py-14 sm:py-20">
            <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">For manufacturers, traders and suppliers</p>
            <h1 className="mt-3 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-ink sm:text-5xl lg:text-[3.5rem]">
              Real buyers. Fewer leads. <span className="text-brand-600">Your rank, your score, your call.</span>
            </h1>
            <p className="mt-5 max-w-2xl text-base text-muted sm:text-lg">
              Broadcast platforms sell the same enquiry to everyone. We match each buyer to a few relevant sellers, show you how serious the buyer is, and refund you when a lead turns out fake.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href={cta.href} className={buttonClasses("primary", "lg")}>
                {cta.label} <ArrowRight className="size-4" aria-hidden />
              </Link>
              <a href="#pricing" className={buttonClasses("outline", "lg")}>
                See pricing
              </a>
            </div>
            <p className="mt-3 text-sm text-muted">No GST needed to start. First listing in about five minutes.</p>
          </Container>
        </section>

        <Container className="py-12 sm:py-14">
          <h2 className="text-xl font-bold text-ink sm:text-[22px]">Why sellers switch</h2>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {VALUE.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <Card className="h-full">
                  <CardBody>
                    <Icon className="size-5 text-brand-600" aria-hidden />
                    <h3 className="mt-3 font-semibold text-ink">{title}</h3>
                    <p className="mt-1 text-sm text-muted">{body}</p>
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        </Container>

        <section className="bg-surface">
          <Container className="py-12 sm:py-14">
            <h2 className="text-xl font-bold text-ink sm:text-[22px]">How it works</h2>
            <ol className="mt-6 grid gap-6 md:grid-cols-3">
              {STEPS.map((s) => (
                <li key={s.n} className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-600 font-bold text-white">{s.n}</span>
                  <div>
                    <h3 className="font-semibold text-ink">{s.title}</h3>
                    <p className="mt-1 text-sm text-muted">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Container>
        </section>

        <Container className="py-12 sm:py-14">
          <div id="pricing" className="scroll-mt-20">
            <h2 className="text-xl font-bold text-ink sm:text-[22px]">Pricing, in public</h2>
            <p className="mt-1 text-sm text-muted">One credit per accepted lead. Unused credits roll over for 90 days. Plans never renew on their own and you can cancel in three taps.</p>
            {plans.ok ? (
              <ul className="mt-6 grid gap-4 md:grid-cols-3">
                {plans.data.map((p) => (
                  <li key={p.code}>
                    <Card className="h-full">
                      <CardBody className="flex h-full flex-col gap-3">
                        <h3 className="font-semibold text-ink">{p.name}</h3>
                        <p>
                          {p.monthlyPricePaise === 0 ? <span className="text-2xl font-bold text-ink">Free</span> : <Money paise={p.monthlyPricePaise} unit="month" className="text-2xl" />}
                        </p>
                        <p className="text-sm text-ink">{p.monthlyCredits} lead credits every month</p>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                          {p.features.map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      </CardBody>
                    </Card>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted">Plan details are not available right now. Sign up and see them in Billing.</p>
            )}
            <div className="mt-8">
              <Link href={cta.href} className={buttonClasses("primary", "lg")}>
                {cta.label}
              </Link>
            </div>
          </div>
        </Container>
      </main>

      <footer className="border-t border-line bg-surface py-6 text-sm text-muted">
        <Container className="flex flex-col gap-2 sm:flex-row sm:justify-between">
          <span>Verification badges reflect your real verification tier, never your plan.</span>
          <Link href="/signin" className="font-medium text-brand-700">
            Sign in
          </Link>
        </Container>
      </footer>
    </div>
  );
}
