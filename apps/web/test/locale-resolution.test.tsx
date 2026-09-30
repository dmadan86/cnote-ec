import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isCookieLocalePath, LOCALE_COOKIE, matchAcceptLanguage, resolvePreferredLocale, toLocale } from "@/i18n/config";

// ---- pure resolution -------------------------------------------------------------------------------------------------
describe("locale for unprefixed routes: matchAcceptLanguage", () => {
  it("honours q-values, region tags and skips unsupported languages", () => {
    expect(matchAcceptLanguage("fr-FR,ta-IN;q=0.8,hi;q=0.5")).toBe("hi");
    expect(matchAcceptLanguage("en;q=0.4, hi;q=0.9")).toBe("hi");
    expect(matchAcceptLanguage("bn-BD")).toBeNull(); // disabled locale
    expect(matchAcceptLanguage("*, de")).toBeNull();
    expect(matchAcceptLanguage("kn;q=0")).toBeNull();
    expect(matchAcceptLanguage("")).toBeNull();
    expect(matchAcceptLanguage(null)).toBeNull();
  });
  it("toLocale normalises tags and rejects unknown ones", () => {
    expect(toLocale("hi-IN")).toBe("hi");
    expect(toLocale("HI_in")).toBe("hi");
    for (const d of ["te", "kn-IN", "ta", "mr", "gu", "bn"]) expect(toLocale(d), d).toBeNull();
    expect(toLocale("pa")).toBeNull();
    expect(toLocale(undefined)).toBeNull();
  });
});

describe("locale for unprefixed routes: resolution order cookie > preferredLanguage > Accept-Language > en", () => {
  const src = (cookie: string | undefined, preferred: string | undefined, accept: string | undefined) => ({
    cookie: vi.fn(() => cookie),
    preferred: vi.fn(() => preferred),
    acceptLanguage: vi.fn(() => accept),
  });
  it("cookie wins and the session is not even loaded", async () => {
    const s = src("hi", "en", "ta");
    expect(await resolvePreferredLocale(s)).toBe("hi");
    expect(s.preferred).not.toHaveBeenCalled();
    expect(s.acceptLanguage).not.toHaveBeenCalled();
  });
  it("falls to the signed-in preferredLanguage when the cookie is absent or invalid", async () => {
    expect(await resolvePreferredLocale(src(undefined, "hi", "en"))).toBe("hi");
    expect(await resolvePreferredLocale(src("xx", "hi-IN", "en"))).toBe("hi");
  });
  it("then Accept-Language, then English", async () => {
    expect(await resolvePreferredLocale(src(undefined, undefined, "hi-IN,en;q=0.5"))).toBe("hi");
    expect(await resolvePreferredLocale(src(undefined, "pa", "fr"))).toBe("en");
    expect(await resolvePreferredLocale(src(undefined, undefined, undefined))).toBe("en");
  });
  it("never resolves to a disabled locale from any source (cookie, profile, Accept-Language)", async () => {
    expect(await resolvePreferredLocale(src("kn", "mr", "ta"))).toBe("en");
    expect(await resolvePreferredLocale(src("kn", "hi", "ta"))).toBe("hi");
    expect(await resolvePreferredLocale(src(undefined, "bn", "te-IN,hi;q=0.5"))).toBe("hi");
  });
  it("knows which unprefixed routes are cookie-localised (storefronts are not)", () => {
    for (const p of ["/account", "/account/notifications", "/buyer/orders/1", "/rfq/new", "/wishlist", "/compare", "/signin", "/onboarding", "/grievance", "/conversations/x"]) expect(isCookieLocalePath(p), p).toBe(true);
    for (const p of ["/store/acme", "/search", "/", "/accountant"]) expect(isCookieLocalePath(p), p).toBe(false);
  });
});

// ---- cookie + profile persistence -----------------------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  set: vi.fn(),
  session: null as null | { personId: string; preferredLanguage: string },
  updateProfile: vi.fn(async () => undefined),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ set: h.set }), headers: async () => new Headers() }));
vi.mock("@cnote/next-kit", () => ({ currentSession: async () => h.session }));
vi.mock("@cnote/identity", () => ({ updateProfile: h.updateProfile }));

describe("setLocaleAction (language switcher, server side)", () => {
  beforeEach(() => {
    h.set.mockClear();
    h.updateProfile.mockClear();
    h.session = null;
  });
  it("sets the cnote_locale cookie for a guest and touches no profile", async () => {
    const { setLocaleAction } = await import("@/lib/locale-actions");
    expect(await setLocaleAction("hi")).toEqual({ ok: true });
    expect(h.set).toHaveBeenCalledWith(LOCALE_COOKIE, "hi", expect.objectContaining({ path: "/", sameSite: "lax", httpOnly: false, maxAge: 31536000 }));
    expect(h.updateProfile).not.toHaveBeenCalled();
  });
  it("also persists preferredLanguage for a signed-in person, only when it changed", async () => {
    const { setLocaleAction } = await import("@/lib/locale-actions");
    h.session = { personId: "p1", preferredLanguage: "en" };
    await setLocaleAction("hi");
    expect(h.updateProfile).toHaveBeenCalledWith("p1", { preferredLanguage: "hi" });
    h.updateProfile.mockClear();
    h.session = { personId: "p1", preferredLanguage: "hi-IN" };
    await setLocaleAction("hi");
    expect(h.updateProfile).not.toHaveBeenCalled();
  });
  it("ignores unknown languages and survives a failing profile save", async () => {
    const { setLocaleAction } = await import("@/lib/locale-actions");
    expect(await setLocaleAction("zz")).toEqual({ ok: false });
    expect(await setLocaleAction("kn")).toEqual({ ok: false }); // disabled locale
    expect(h.set).not.toHaveBeenCalled();
    h.session = { personId: "p1", preferredLanguage: "en" };
    h.updateProfile.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await setLocaleAction("hi")).toEqual({ ok: true });
    expect(h.set).toHaveBeenCalledWith(LOCALE_COOKIE, "hi", expect.anything());
  });
});

describe("rememberLocale (client cookie written when visiting a localised page)", () => {
  it("writes cnote_locale once, and ignores unknown values", async () => {
    const jar: string[] = [];
    vi.stubGlobal("document", {
      get cookie() {
        return jar.join("; ");
      },
      set cookie(v: string) {
        jar.length = 0;
        jar.push(v.split(";")[0]!);
      },
    });
    vi.stubGlobal("location", { protocol: "https:" });
    const { rememberLocale } = await import("@/i18n/locale-cookie");
    rememberLocale("zz");
    expect(jar).toEqual([]);
    rememberLocale("mr"); // disabled
    expect(jar).toEqual([]);
    rememberLocale("hi");
    expect(jar).toEqual(["cnote_locale=hi"]);
    vi.unstubAllGlobals();
  });
});

// ---- <html lang> and chrome for the (app) route group ------------------------------------------------------------------------
let mockSegment: string | null = "(app)";
vi.mock("next/navigation", () => ({ useSelectedLayoutSegment: () => mockSegment, usePathname: () => "/account", useRouter: () => ({ push: () => undefined, refresh: () => undefined }) }));

describe("HtmlShell for the dynamic (app) routes", () => {
  it("renders children only (the (app) layout supplies the translated chrome) and defers lang to HtmlLang", async () => {
    const { HtmlShell } = await import("@/i18n/html-shell");
    const props = { className: "x", messages: {}, skip: "SKIP", header: "ENGLISH-HEADER", footer: "ENGLISH-FOOTER", extras: null };
    mockSegment = "(app)";
    const html = renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>);
    expect(html).toContain("page");
    expect(html).not.toContain("ENGLISH-HEADER");
    expect(html).not.toContain("ENGLISH-FOOTER");
    mockSegment = "store";
    expect(renderToStaticMarkup(<HtmlShell {...props}>page</HtmlShell>)).toContain("ENGLISH-HEADER"); // storefronts keep the English shell
  });
});
