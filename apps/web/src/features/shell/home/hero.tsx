import { BadgeCheck, Boxes, Factory, Sparkles, Tag, Truck, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Container } from "@cnote/ui";
import { SITE_NAME } from "../site";
import { HeroVisual } from "./hero-visual";
import { SearchCard } from "@/features/search/search-card";

const TICKS: { icon: LucideIcon; label: string }[] = [
  { icon: BadgeCheck, label: "Verified suppliers" },
  { icon: Tag, label: "Best prices" },
  { icon: Boxes, label: "Bulk orders" },
  { icon: Truck, label: "Pan India delivery" },
];

const VALUE_CARDS: { icon: LucideIcon; title: string; sub: string; href: string; tint: string; tilt: string }[] = [
  { icon: Factory, title: "Find verified manufacturers", sub: "Get quotes in minutes", href: "/manufacturers", tint: "bg-brand-100 text-brand-700", tilt: "lg:-rotate-3 lg:self-start" },
  { icon: Sparkles, title: "Create custom designs with AI", sub: "Logos, packaging, banners", href: "/coming-soon/ai-design", tint: "bg-accent-100 text-accent-600", tilt: "lg:-rotate-2 lg:self-end" },
  { icon: Tag, title: "Source products at best prices", sub: "Wide range, bulk orders", href: "/search?tab=products", tint: "bg-green-100 text-green-700", tilt: "lg:-rotate-3 lg:self-start" },
];

export function Hero({ suggestions }: { suggestions: string[] }) {
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden bg-gradient-to-r from-brand-50 via-white to-white">
      {/* Warehouse backdrop, right half on desktop only (nothing heavy on mobile). */}
      <div className="pointer-events-none absolute inset-y-0 right-0 -z-10 hidden w-3/5 lg:block">
        <HeroVisual className="size-full" />
        <div className="absolute inset-0 bg-gradient-to-r from-white via-white/40 to-transparent" />
      </div>
      <Container className="grid gap-8 py-8 lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)_minmax(0,320px)] lg:items-center lg:gap-6 lg:py-12">
        <div>
          <h1 id="hero-title" className="text-[2.5rem] font-extrabold leading-[1.05] tracking-tight text-ink sm:text-5xl lg:text-[3.25rem]">
            Everything Your Business Needs
            <span className="block text-brand-600">in One Place</span>
          </h1>
          <p className="mt-4 max-w-md text-base text-muted sm:text-lg">
            Source products, find verified manufacturers, create designs, and grow your business, powered by AI.
          </p>
          <ul className="mt-5 grid grid-cols-2 gap-x-4 gap-y-2 text-sm font-medium text-ink">
            {TICKS.map((t) => (
              <li key={t.label} className="flex items-center gap-2">
                <span className="inline-flex size-6 items-center justify-center rounded-full bg-brand-100 text-brand-700">
                  <t.icon className="size-3.5" aria-hidden />
                </span>
                {t.label}
              </li>
            ))}
          </ul>
        </div>

        <SearchCard suggestions={suggestions} />

        <div className="grid gap-3 sm:grid-cols-3 lg:flex lg:flex-col lg:gap-4" aria-label={`Why ${SITE_NAME}`}>
          {VALUE_CARDS.map((c) => (
            <Link
              key={c.title}
              href={c.href}
              className={`group flex items-center gap-3 rounded-2xl border border-line bg-surface/95 p-3.5 shadow-md transition-shadow hover:shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 lg:w-72 ${c.tilt}`}
            >
              <span className={`inline-flex size-11 shrink-0 items-center justify-center rounded-xl ${c.tint}`}>
                <c.icon className="size-5" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold leading-tight text-ink">{c.title}</span>
                <span className="mt-0.5 block text-xs text-muted">{c.sub} →</span>
              </span>
            </Link>
          ))}
        </div>
      </Container>
    </section>
  );
}
