import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ALL_LOCALES, isLocalizedPath, LOCALES, localizePath } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import { ARTICLES, articleById, helpPath, isTopic, matchesQuery, popularArticles, TOPIC_IDS } from "@/features/help/articles";
import { NAV, visibleNav } from "@/features/shell/site";

// Server-side getTranslations is not available under vitest; serve it from the same catalogue.
vi.mock("next-intl/server", async () => {
  const { loadMessages: load } = await import("@/i18n/messages");
  return { getTranslations: async ({ locale, namespace }: { locale: "en" | "hi"; namespace: string }) => createTranslator({ locale, messages: (await load(locale)) as never, namespace: namespace as never }) };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/help", useRouter: () => ({ push: () => undefined }) }));

type Json = { [k: string]: Json | string };
const pick = (o: Json, path: string): string | undefined => {
  const v = path.split(".").reduce<Json | string | undefined>((acc, k) => (typeof acc === "object" ? acc[k] : undefined), o);
  return typeof v === "string" ? v : undefined;
};

describe("help centre content", () => {
  it("every article and topic has its copy in every locale", async () => {
    for (const locale of ALL_LOCALES) {
      const m = (await loadMessages(locale)) as unknown as Json;
      for (const t of TOPIC_IDS) for (const k of ["title", "desc"]) expect(pick(m, `help.topic.${t}.${k}`), `${locale} topic ${t}.${k}`).toBeTruthy();
      for (const a of ARTICLES) for (const k of ["title", "summary", "h1", "p1", "h2", "p2", "q", "ans"]) expect(pick(m, `help.a.${a.id}.${k}`), `${locale} ${a.id}.${k}`).toBeTruthy();
    }
  });
  it("has about 15 articles in the six topics, unique ids, valid related links", () => {
    expect(ARTICLES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(ARTICLES.map((a) => a.id)).size).toBe(ARTICLES.length);
    for (const t of TOPIC_IDS) expect(ARTICLES.some((a) => a.topic === t), t).toBe(true);
    for (const a of ARTICLES) {
      expect(isTopic(a.topic)).toBe(true);
      for (const r of a.related) expect(articleById(r), `${a.id} -> ${r}`).toBeDefined();
    }
    expect(popularArticles().length).toBeGreaterThanOrEqual(4);
  });
  it("is a localised public path, so it is prefixed in Hindi and never in the account area", () => {
    expect(isLocalizedPath("/help")).toBe(true);
    expect(isLocalizedPath("/help/buying/post-requirement")).toBe(true);
    expect(isLocalizedPath("/offline")).toBe(true);
    expect(localizePath(helpPath(ARTICLES[0]!), "hi")).toBe("/hi/help/buying/post-requirement");
    expect(LOCALES).toContain("hi");
  });
  it("states the facts the product guarantees (ADR-002/003/005)", async () => {
    const m = (await loadMessages("en")) as unknown as Json;
    const text = (id: string) => ["p1", "p2", "ans"].map((k) => pick(m, `help.a.${id}.${k}`)).join(" ");
    expect(text("post-requirement")).toMatch(/at most 3 suppliers/);
    expect(text("post-requirement")).toMatch(/2 hours/);
    expect(text("decline-cascade")).toMatch(/2 hours/);
    expect(text("auto-refund")).toMatch(/72 hours/);
    expect(text("rollover-renewal")).toMatch(/90 days/);
    expect(text("rollover-renewal")).toMatch(/without your confirmation/);
    expect(text("how-ranked")).toMatch(/never|No\./i);
  });
  it("search matches title and summary words, ignoring case", () => {
    expect(matchesQuery("How suppliers are ranked Relevance multiplied by trust", "RANKED trust")).toBe(true);
    expect(matchesQuery("How suppliers are ranked", "credits")).toBe(false);
    expect(matchesQuery("anything", "   ")).toBe(true);
  });
});

describe("navigation cleanup", () => {
  const all = NAV.flatMap((g) => g.items);
  it("hides every coming-soon item and any menu whose items are all coming soon", () => {
    const shown = visibleNav();
    expect(shown.flatMap((g) => g.items).some((i) => i.soon)).toBe(false);
    for (const g of shown) expect(g.href || g.items.length > 0).toBeTruthy();
    expect(shown.map((g) => g.key)).not.toContain("templates");
    expect(shown.map((g) => g.key)).not.toContain("services");
    expect(shown.map((g) => g.key)).toEqual(expect.arrayContaining(["products", "manufacturers", "aiTools", "help"]));
    // The coming-soon routes remain defined for direct links.
    expect(all.filter((i) => i.soon).length).toBeGreaterThan(0);
  });
  it("replaces Resources with a plain Help link to /help", () => {
    expect(NAV.find((g) => g.key === "resources")).toBeUndefined();
    expect(NAV.find((g) => g.key === "help")).toMatchObject({ href: "/help" });
  });
  it("renders the Help link and no coming-soon badge in the header and mobile menus", async () => {
    const en = await loadMessages("en");
    const { NavMenus } = await import("@/features/shell/nav-menus");
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        {await NavMenus({ locale: "en" })}
      </NextIntlClientProvider>,
    );
    expect(html).toContain('href="/help"');
    expect(html).not.toMatch(/Coming soon|coming-soon/);
    expect(html).not.toContain("Templates &amp; Design");
    expect(html).not.toContain("Business Services");
  });
  it("keeps the coming-soon routes reachable", () => {
    const route = join(__dirname, "..", "src", "app", "[locale]", "(discover)", "coming-soon");
    expect(readFileSync(join(route, "[feature]", "page.tsx"), "utf8").length).toBeGreaterThan(0);
  });
});
