import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { Card, CardBody, buttonClasses } from "@cnote/ui";
import { requireSeller } from "@/lib/auth";

export const metadata: Metadata = { title: "You are all set" };

export default async function OnboardingDonePage() {
  const session = await requireSeller("/onboarding/done");
  const tier = session.business.verificationTier;
  const next = [
    { title: "Watch for your first lead", body: "Leads that match your listings show up under Leads. You have 2 hours to accept or decline each one, and nothing is charged until you accept.", href: "/leads", cta: "Open leads" },
    ...(tier < 1 ? [{ title: "Verify your GST", body: "Get the GST verified badge and rank higher with buyers.", href: "/verification", cta: "Verify GST" }] : []),
    { title: "Add more listings", body: "Every extra product you list gives us more to match you with.", href: "/listings/new", cta: "New listing" },
  ];
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <CheckCircle2 className="mt-1 size-7 shrink-0 text-success" aria-hidden />
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">You are all set, {session.business.name}</h1>
          <p className="mt-1 text-sm text-muted">Your seller account is ready. Here is what to do next.</p>
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
      <Link href="/dashboard" className={buttonClasses("primary", "lg")}>Go to dashboard</Link>
    </div>
  );
}
