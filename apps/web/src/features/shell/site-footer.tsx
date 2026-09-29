import Link from "next/link";
import { Container, LogoMark } from "@cnote/ui";
import { SELLER_APP_URL, SITE_NAME, SITE_TAGLINE } from "./site";

const COLS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  {
    title: "Buy",
    links: [
      { label: "All products", href: "/search?tab=products" },
      { label: "Categories", href: "/categories" },
      { label: "Manufacturers", href: "/manufacturers" },
      { label: "Post a requirement", href: "/rfq/new" },
    ],
  },
  {
    title: "Sell",
    links: [
      { label: `Sell on ${SITE_NAME}`, href: SELLER_APP_URL, external: true },
      { label: "Join for free", href: "/signup" },
    ],
  },
  {
    title: "Explore",
    links: [
      { label: "AI Design", href: "/coming-soon/ai-design" },
      { label: "Templates & Design", href: "/coming-soon/templates-design" },
      { label: "Business Services", href: "/coming-soon/business-services" },
      { label: "Resources", href: "/coming-soon/resources" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-line bg-surface">
      <Container className="grid gap-8 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <LogoMark className="size-7" />
            <span className="text-lg font-extrabold text-ink">{SITE_NAME}</span>
          </div>
          <p className="mt-3 max-w-xs text-sm text-muted">{SITE_TAGLINE}. Suppliers are ranked by relevance and trust, never by payment.</p>
        </div>
        {COLS.map((c) => (
          <nav key={c.title} aria-label={c.title}>
            <h2 className="text-sm font-bold text-ink">{c.title}</h2>
            <ul className="mt-3 space-y-2 text-sm">
              {c.links.map((l) => (
                <li key={l.label}>
                  {l.external ? (
                    <a href={l.href} className="inline-flex min-h-8 items-center text-muted hover:text-brand-700 hover:underline">
                      {l.label}
                    </a>
                  ) : (
                    <Link href={l.href} className="inline-flex min-h-8 items-center text-muted hover:text-brand-700 hover:underline">
                      {l.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </Container>
      <div className="border-t border-line py-4 text-center text-xs text-muted">
        © {new Date().getFullYear()} {SITE_NAME}. Product data shown is sample data during development.{" "}
        <a href="/llms.txt" className="inline-flex min-h-8 items-center underline hover:text-brand-700">
          llms.txt
        </a>
      </div>
    </footer>
  );
}
