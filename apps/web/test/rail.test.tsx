import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "../messages/en.rail.json";
import hi from "../messages/hi.rail.json";
import { activeHref, DISCOVER_GROUP, PROFILE_HREF, RAIL_ITEMS, railGroups, SIGNED_OUT_GROUP } from "@/features/rail/items";
import { RAIL_SCRIPT_CSP_SOURCE } from "@/features/rail/csp";
import { applyRailState, parseRailState, railCookie, railFromCookieString, RAIL_SCRIPT } from "@/features/rail/state";

let mockPath = "/buyer/enquiries";
let mockUser = { status: "ready", signedIn: true };
vi.mock("next/navigation", () => ({ usePathname: () => mockPath, useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/features/user-state/store", () => ({ useUserState: () => mockUser }));
const { SiteRail, SectionStrip } = await import("@/features/rail/buyer-rail");

const SRC = join(__dirname, "..", "src", "app");
const APP = join(SRC, "(app)", "(dashboard)");
const routeExists = (href: string) =>
  ["(app)/(dashboard)", "(app)", "[locale]", "[locale]/(discover)"].some((d) =>
    ["page.tsx", "route.ts"].some((f) => existsSync(join(SRC, d, href === "/" ? "" : href, f))),
  );
const render = (node: React.ReactNode, locale: "en" | "hi" = "en") =>
  renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi}>{node}</NextIntlClientProvider>);
const signedOut = () => { mockUser = { status: "ready", signedIn: false }; };
const signedIn = () => { mockUser = { status: "ready", signedIn: true }; };

describe("rail items", () => {
  it("only lists routes that exist", () => {
    for (const it of [...DISCOVER_GROUP, ...SIGNED_OUT_GROUP, ...RAIL_ITEMS]) expect(routeExists(it.href), it.href).toBe(true);
    expect(routeExists(PROFILE_HREF)).toBe(true);
    expect(routeExists("/signin") || existsSync(join(SRC, "(app)", "(auth)", "signin", "page.tsx"))).toBe(true);
    expect(existsSync(APP)).toBe(true);
  });
  it("has a label in en and hi for every item", () => {
    for (const it of [...DISCOVER_GROUP, ...SIGNED_OUT_GROUP, ...RAIL_ITEMS]) {
      expect(en.rail[it.label]).toBeTruthy();
      expect(hi.rail[it.label]).toMatch(/[\u0900-\u097F]/);
    }
  });
  it("signed-out visitors get the public items, signed-in users the account groups on top", () => {
    const out = railGroups(false).flat().map((i) => i.href);
    expect(out).toEqual(["/", "/search", "/categories", "/manufacturers", "/pricing", "/rfq/new", "/compare"]);
    const inn = railGroups(true).flat().map((i) => i.href);
    expect(inn).toEqual(expect.arrayContaining(["/", "/pricing", "/account", "/buyer/enquiries", "/wishlist", "/account/notifications"]));
    expect(new Set(inn).size).toBe(inn.length); // no duplicated destinations
  });
  it("matches the longest prefix on segment boundaries", () => {
    expect(activeHref("/account")).toBe("/account");
    expect(activeHref("/account/notifications/preferences")).toBe("/account/notifications");
    expect(activeHref("/buyer/enquiries/abc")).toBe("/buyer/enquiries");
    expect(activeHref("/buyer/agents/mandates/1")).toBe("/buyer/agents");
    expect(activeHref("/accountant")).toBeNull();
    expect(activeHref("/buyer/enquiries/")).toBe("/buyer/enquiries");
    expect(activeHref("/account/export")).toBe("/account"); // download links are never matched themselves
  });
  it("ignores the locale prefix; / only matches the home page", () => {
    expect(activeHref("/")).toBe("/");
    expect(activeHref("/hi")).toBe("/");
    expect(activeHref("/hi/")).toBe("/");
    expect(activeHref("/hi/search")).toBe("/search");
    expect(activeHref("/hi/manufacturers/x")).toBe("/manufacturers");
    expect(activeHref("/hi/c/steel")).toBeNull();
    expect(activeHref("/nowhere")).toBeNull();
  });
});

describe("rail state (cookie + <html data-rail>)", () => {
  it("defaults to collapsed and only accepts expanded", () => {
    expect(parseRailState(undefined)).toBe("collapsed");
    expect(parseRailState("junk")).toBe("collapsed");
    expect(parseRailState("expanded")).toBe("expanded");
  });
  it("writes a 1-year, site-wide, Lax cookie", () => {
    expect(railCookie("expanded")).toBe("cnote_rail=expanded; path=/; max-age=31536000; SameSite=Lax");
  });
  it("reads the cookie out of a document.cookie string", () => {
    expect(railFromCookieString("a=1; cnote_rail=expanded; b=2")).toBe("expanded");
    expect(railFromCookieString("xcnote_rail=expanded")).toBe("collapsed");
    expect(railFromCookieString("")).toBe("collapsed");
  });
  const runScript = (cookie: string) => {
    const doc = { cookie, documentElement: { dataset: {} as Record<string, string> } };
    new Function("document", RAIL_SCRIPT)(doc);
    return doc.documentElement.dataset.rail;
  };
  it("the pre-paint script copies the cookie to the attribute", () => {
    expect(runScript("cnote_rail=expanded")).toBe("expanded");
    expect(runScript("x=1; cnote_rail=collapsed")).toBe("collapsed");
    expect(runScript("")).toBe("collapsed");
    expect(runScript("cnote_rail=evil")).toBe("collapsed");
  });
  it("applyRailState sets both", () => {
    const doc = { cookie: "", documentElement: { dataset: {} as Record<string, string> } } as unknown as Document;
    applyRailState("expanded", doc);
    expect(doc.documentElement.dataset.rail).toBe("expanded");
    expect(doc.cookie).toContain("cnote_rail=expanded");
  });
  it("its CSP hash is a sha256 source", () => {
    expect(RAIL_SCRIPT_CSP_SOURCE).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
  });
});

describe("rail markup", () => {
  it("signed out, English home: server HTML is the collapsed markup with public items and a Sign in entry", () => {
    signedOut();
    mockPath = "/";
    const html = render(<SiteRail />);
    expect(html).toContain('aria-label="Site navigation"');
    expect(html).not.toContain("data-rail"); // state is CSS-driven from <html>, never per-render
    expect(html).toMatch(/aria-current="page"[^>]*>.*?Home/);
    for (const t of ["Search", "Categories", "Manufacturers", "Pricing", "Request quote", "Compare", "Sign in"]) expect(html).toContain(t);
    expect(html).not.toContain("My requirements");
    expect(html).toContain('href="/signin"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="buyer-rail"');
    expect(html).toContain('class="sr-only rail-expanded:hidden">Expand sidebar');
    expect(html).toContain("rail-expanded:w-60");
  });
  it("signed in: account items and a Your account entry", () => {
    signedIn();
    mockPath = "/buyer/enquiries";
    const html = render(<SiteRail />);
    expect(html).toMatch(/aria-current="page"[^>]*>.*?My requirements/);
    expect(html).toContain("Your account");
    expect(html).not.toContain(">Sign in<");
  });
  it("Hindi: /hi keeps the locale prefix on localisable paths only", () => {
    signedOut();
    mockPath = "/hi/search";
    const html = render(<SiteRail />, "hi");
    expect(html).toContain('href="/hi"');
    expect(html).toContain('href="/hi/search"');
    expect(html).toContain('href="/hi/categories"');
    expect(html).toContain('href="/rfq/new"'); // not a localised path
    expect(html).toContain('href="/signin"');
    expect(html).toMatch(/aria-current="page"[^>]*>.*?खोजें/);
    expect(html).toContain('aria-label="साइट नेविगेशन"');
  });
  it("Hindi strip landmark stays distinct; rail namespace is a client namespace", () => {
    const html = render(<><SiteRail /><SectionStrip /></>, "hi");
    expect(html).toContain('aria-label="खाते के अनुभाग"');
    expect(readFileSync(join(__dirname, "..", "src", "i18n", "messages.ts"), "utf8")).toMatch(/CLIENT_NAMESPACES = \[[^\]]*"rail"/);
  });
});
