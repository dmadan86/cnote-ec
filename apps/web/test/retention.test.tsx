import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.retention.json";
import hi from "../messages/hi.retention.json";

const BIZ = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const h = vi.hoisted(() => ({
  session: null as null | { personId: string },
  user: { status: "ready", signedIn: false } as { status: string; signedIn: boolean },
  following: new Set<string>(),
  calls: [] as unknown[],
  prefs: { in_app: false, email: false },
  failFollow: null as null | Error,
}));
vi.mock("@cnote/next-kit", () => ({
  currentSession: async () => h.session,
  requireSession: async () => {
    if (!h.session) throw new Error("redirect");
    return h.session;
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/manufacturers/x", useRouter: () => ({ push: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void h.calls.push(["revalidate", p]) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/request-locale", () => ({ getRequestLocale: async () => "en" }));
vi.mock("@/i18n/errors", () => ({
  runLocalized: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true, data: await fn() };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "x" };
    }
  },
}));
vi.mock("@/features/user-state/store", () => ({ useUserState: () => h.user, ensureFresh: async () => undefined }));
vi.mock("@cnote/notifications", () => ({
  getPreferences: async () => ({ alerts: h.prefs }),
  setPreference: async (...a: unknown[]) => void h.calls.push(["pref", ...a]),
}));
vi.mock("@cnote/alerts", () => ({
  SEARCH_FREQUENCIES: ["off", "daily", "weekly"],
  isFollowing: async (_p: string, b: string) => h.following.has(b),
  followSupplier: async (_p: string, b: string) => {
    if (h.failFollow) throw h.failFollow;
    h.following.add(b);
    return { following: true, created: true };
  },
  unfollowSupplier: async (_p: string, b: string) => {
    h.following.delete(b);
    return { following: false, removed: true };
  },
  createSavedSearch: async (p: string, i: unknown) => {
    h.calls.push(["create", p, i]);
    return { id: "s1" };
  },
  setSearchFrequency: async (...a: unknown[]) => void h.calls.push(["freq", ...a]),
  deleteSavedSearch: async (...a: unknown[]) => void h.calls.push(["delete", ...a]),
  setAlertSetting: async (...a: unknown[]) => void h.calls.push(["setting", ...a]),
  unsubscribeByToken: async (t: string) => (t === "good" ? "price_drop" : null),
  verifyUnsubscribeToken: (t: string) => (t === "good" ? { personId: "p", type: "price_drop" } : null),
}));

import { filtersToState, parseFiltersField, savedSearchHref } from "@/features/retention/search-url";
import { parseFilterState, toSearchArgs } from "@/features/search/filter-state";
import { canRequestAgain } from "@/features/retention/request-again";
import { FollowIsland } from "@/features/retention/follow-island";
import { SaveSearch } from "@/features/retention/save-search";
import { AlertSettingsForm } from "@/features/retention/alert-settings-form";
import { UnsubscribeForm } from "@/features/retention/unsubscribe-form";
import { SavedSearchRow } from "@/features/retention/saved-search-row";
import { UnfollowButton } from "@/features/retention/unfollow-button";
import * as actions from "@/features/retention/actions";
const { GET } = await import("@/app/api/follow/[businessId]/route");

const render = (node: React.ReactNode, locale: "en" | "hi" = "en") =>
  renderToStaticMarkup(<NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi}>{node}</NextIntlClientProvider>);
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

beforeEach(() => {
  h.session = null;
  h.user = { status: "ready", signedIn: false };
  h.following = new Set();
  h.calls = [];
  h.prefs = { in_app: false, email: false };
  h.failFollow = null;
});

describe("saved search <-> /search URL", () => {
  it("round-trips the filters a search page hands to searchListings", () => {
    const url = new URLSearchParams("q=cotton+yarn&category=yarn&tier=2&state=gujarat&city=surat&pmin=100&pmax=5000&moq=50&priced=1&sort=price_asc");
    const state = parseFilterState(Object.fromEntries(url.entries()));
    const { filters, sort } = toSearchArgs(state);
    const href = savedSearchHref({ query: "cotton yarn", filters: filters as Record<string, unknown>, sort });
    const back = new URL(href, "http://x");
    expect(back.pathname).toBe("/search");
    const again = toSearchArgs(parseFilterState(Object.fromEntries([...back.searchParams.entries()].map(([k, v]) => [k, back.searchParams.getAll(k).length > 1 ? back.searchParams.getAll(k) : v]))));
    expect(again).toEqual({ filters, sort });
    expect(back.searchParams.get("q")).toBe("cotton yarn");
  });
  it("an empty/odd saved search still yields a valid URL", () => {
    expect(savedSearchHref({ query: "", filters: {}, sort: "bogus" })).toBe("/search");
    expect(filtersToState(undefined, undefined).sort).toBe("relevance");
    expect(savedSearchHref({ query: "boxes", filters: {}, sort: "relevance" })).toBe("/search?q=boxes");
  });
  it("parses the hidden filters field defensively", () => {
    expect(parseFiltersField('{"minTier":2}')).toEqual({ minTier: 2 });
    for (const bad of [null, undefined, "", "nope", "[1]", "null", "x".repeat(5000), 5]) expect(parseFiltersField(bad)).toEqual({});
  });
});

describe("Request again", () => {
  it("is offered for closed, quoted or expired requirements only", () => {
    const now = Date.parse("2026-10-02T00:00:00Z");
    expect(canRequestAgain({ status: "closed", expiresAt: null }, now)).toBe(true);
    expect(canRequestAgain({ status: "matched", quoteCount: 2, expiresAt: null }, now)).toBe(true);
    expect(canRequestAgain({ status: "matched", quoteCount: 0, expiresAt: "2026-09-01T00:00:00Z" }, now)).toBe(true);
    expect(canRequestAgain({ status: "matched", quoteCount: 0, expiresAt: "2026-10-09T00:00:00Z" }, now)).toBe(false);
    expect(canRequestAgain({ status: "scoring", expiresAt: null }, now)).toBe(false);
  });
});

describe("GET /api/follow/[businessId]", () => {
  const ctx = (id: string) => ({ params: Promise.resolve({ businessId: id }) }) as never;
  const req = () => new NextRequest(`http://localhost/api/follow/${BIZ}`);
  it("is private, no-store and never reveals anything to guests", async () => {
    h.following.add(BIZ);
    const res = await GET(req(), ctx(BIZ));
    expect(await res.json()).toEqual({ following: false, signedIn: false });
    expect(res.headers.get("cache-control")).toMatch(/private, no-store/);
  });
  it("answers for the signed-in buyer; malformed ids are 404", async () => {
    h.session = { personId: "p1" };
    h.following.add(BIZ);
    expect(await (await GET(req(), ctx(BIZ))).json()).toEqual({ following: true, signedIn: true });
    expect((await GET(req(), ctx("nope"))).status).toBe(404);
  });
});

describe("server actions", () => {
  it("toggleFollowAction: guests are told to sign in; signed-in buyers follow then unfollow", async () => {
    expect(await actions.toggleFollowAction(BIZ)).toEqual({ ok: false, error: "follow.signInToFollow" });
    h.session = { personId: "p1" };
    expect(await actions.toggleFollowAction(BIZ)).toEqual({ ok: true, following: true });
    expect(await actions.toggleFollowAction(BIZ)).toEqual({ ok: true, following: false });
    h.failFollow = new Error("You can follow up to 200 suppliers");
    expect(await actions.toggleFollowAction(BIZ)).toEqual({ ok: false, error: "You can follow up to 200 suppliers" });
  });
  it("saveSearchAction passes the URL's query, filters and sort; choosing a frequency makes sure a channel can deliver it", async () => {
    h.session = { personId: "p1" };
    const r = await actions.saveSearchAction(null, fd({ q: "yarn", filters: '{"minTier":2}', sort: "newest", frequency: "weekly", name: " My yarn " }));
    expect(r).toEqual({ ok: true, data: { id: "s1" } });
    expect(h.calls).toContainEqual(["create", "p1", { query: "yarn", filters: { minTier: 2 }, sort: "newest", name: "My yarn", frequency: "weekly" }]);
    expect(h.calls).toContainEqual(["pref", "p1", "alerts", "in_app", true]); // both channels were off
    h.calls = [];
    h.prefs = { in_app: false, email: true };
    await actions.saveSearchAction(null, fd({ q: "yarn", frequency: "daily" }));
    expect(h.calls.some((c) => (c as string[])[0] === "pref")).toBe(false); // a channel already works
    h.calls = [];
    await actions.saveSearchAction(null, fd({ q: "boxes", frequency: "bogus" })); // unknown value = off = no channel change
    expect(h.calls).toContainEqual(["create", "p1", expect.objectContaining({ frequency: "off" })]);
    expect(h.calls.some((c) => (c as string[])[0] === "pref")).toBe(false);
  });
  it("frequency, delete, unfollow and alert settings act for the signed-in person only", async () => {
    await expect(actions.deleteSavedSearchAction(null, fd({ id: "s1" }))).rejects.toThrow("redirect");
    h.session = { personId: "p1" };
    await actions.setSearchFrequencyAction(null, fd({ id: "s1", frequency: "daily" }));
    await actions.deleteSavedSearchAction(null, fd({ id: "s1" }));
    await actions.unfollowAction(null, fd({ businessId: BIZ }));
    expect(h.calls).toEqual(expect.arrayContaining([["freq", "p1", "s1", "daily"], ["delete", "p1", "s1"]]));
    h.calls = [];
    h.prefs = { in_app: true, email: true };
    await actions.saveAlertSettingsAction(null, fd({ priceDrop: "on", "channel:email": "on" }));
    expect(h.calls).toEqual(expect.arrayContaining([
      ["setting", "p1", "price_drop", true], ["setting", "p1", "back_in_stock", false], ["setting", "p1", "followed_digest", false],
      ["pref", "p1", "alerts", "in_app", false], ["pref", "p1", "alerts", "email", true],
    ]));
  });
  it("unsubscribeAlertAction needs no session; a forged token does nothing", async () => {
    expect(await actions.unsubscribeAlertAction(null, fd({ token: "good" }))).toEqual({ ok: true, data: { type: "price_drop" } });
    expect(await actions.unsubscribeAlertAction(null, fd({ token: "forged" }))).toMatchObject({ ok: false });
  });
});

describe("components (static markup)", () => {
  it("FollowIsland: a labelled, unpressed toggle with the privacy hint; same in Hindi", () => {
    const out = render(<FollowIsland businessId={BIZ} name="Sharma Textiles" />);
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('aria-label="Sign in to follow Sharma Textiles"');
    expect(out).toContain("never changes how suppliers are ranked");
    expect(out).toContain('role="status"');
    h.user = { status: "ready", signedIn: true };
    expect(render(<FollowIsland businessId={BIZ} name="Sharma Textiles" />)).toContain('aria-label="Follow Sharma Textiles"');
    expect(render(<FollowIsland businessId={BIZ} name="Sharma" />, "hi")).toContain("फ़ॉलो");
  });
  it("SaveSearch: guests see a sign-in label; the form is closed until opened", () => {
    const out = render(<SaveSearch q="yarn" filters={{ minTier: 2 }} sort="relevance" />);
    expect(out).toContain("Sign in to save this search");
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain('name="frequency"');
    h.user = { status: "ready", signedIn: true };
    expect(render(<SaveSearch q="yarn" filters={{}} sort="relevance" />)).toContain("Save this search");
  });
  it("AlertSettingsForm: every alert type is an individually labelled checkbox that is OFF by default", () => {
    const out = render(<AlertSettingsForm settings={{ priceDrop: false, backInStock: false, followedDigest: false }} channels={{ in_app: true, email: true }} />);
    for (const n of ["priceDrop", "backInStock", "followedDigest"]) expect(out).toMatch(new RegExp(`id="alert-${n}"[^>]*name="${n}"(?![^>]*checked)`));
    expect(out).toContain("Price drops on saved items");
    expect(out).toContain('for="alert-priceDrop"');
    expect(out).toContain('aria-describedby="alert-priceDrop-text"');
    const on = render(<AlertSettingsForm settings={{ priceDrop: true, backInStock: false, followedDigest: false }} channels={{ in_app: true, email: false }} />);
    expect(on).toMatch(/name="priceDrop"[^>]*checked/);
  });
  it("UnsubscribeForm names what will be switched off and carries the token; saved-search row and unfollow button are labelled", () => {
    const out = render(<UnsubscribeForm token="good" type="saved_search" />);
    expect(out).toContain('name="token" value="good"');
    expect(out).toContain("Saved search alerts");
    const row = render(<ul><SavedSearchRow s={{ id: "abc", name: "Cotton", query: "cotton", frequency: "weekly", href: "/search?q=cotton", lastChecked: null, created: "1 Oct 2026" }} /></ul>);
    expect(row).toContain('for="freq-abc"');
    expect(row).toContain('aria-label="Delete saved search Cotton"');
    expect(row).toContain('href="/search?q=cotton"');
    expect(row).toContain("Not checked yet");
    expect(render(<UnfollowButton businessId={BIZ} name="Sharma" />)).toContain('aria-label="Unfollow Sharma"');
  });
});
