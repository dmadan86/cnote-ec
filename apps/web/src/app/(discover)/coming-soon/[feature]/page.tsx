import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles } from "lucide-react";
import { Badge, buttonClasses, Container } from "@cnote/ui";

const FEATURES: Record<string, { title: string; description: string }> = {
  "templates-design": { title: "Templates & Design", description: "Ready-to-use templates for logos, packaging, labels and print materials." },
  "ai-design": { title: "AI Design", description: "Describe your brand and get custom packaging, logos and marketing materials drafted by AI, always editable before you order." },
  "ai-tools": { title: "AI Tools", description: "Assistants that help you compare quotes and source smarter." },
  "business-services": { title: "Business Services", description: "Logistics, compliance and finance partners for growing MSMEs." },
  resources: { title: "Resources", description: "Sourcing guides and playbooks for Indian MSMEs." },
  templates: { title: "Templates", description: "Ready-to-use design templates for your business." },
};

export async function generateMetadata(props: PageProps<"/coming-soon/[feature]">): Promise<Metadata> {
  const { feature } = await props.params;
  return { title: FEATURES[feature] ? `${FEATURES[feature].title} (coming soon)` : "Coming soon" };
}

export default async function ComingSoonPage(props: PageProps<"/coming-soon/[feature]">) {
  const { feature } = await props.params;
  const f = FEATURES[feature];
  if (!f) notFound();
  return (
    <Container className="py-16 lg:py-24">
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 text-center">
        <span className="inline-flex size-14 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <Sparkles className="size-7" aria-hidden />
        </span>
        <Badge tone="brand">Coming soon</Badge>
        <h1 className="text-3xl font-extrabold tracking-tight text-ink">{f.title}</h1>
        <p className="text-base text-muted">{f.description}</p>
        <p className="text-sm text-muted">We are still building this. In the meantime, find verified suppliers or post what you need.</p>
        <div className="mt-2 flex flex-wrap justify-center gap-3">
          <Link href="/search" className={buttonClasses("primary", "lg")}>
            Search products
          </Link>
          <Link href="/rfq/new" className={buttonClasses("accent", "lg")}>
            Request Quote
          </Link>
        </div>
      </div>
    </Container>
  );
}
