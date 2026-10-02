/* eslint-disable @typescript-eslint/no-unused-vars -- vi.fn signatures declare the call args the assertions read */
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.qa.json";
import hi from "../messages/hi.qa.json";

const h = vi.hoisted(() => ({
  session: null as null | { personId: string; business: { id: string } | null; preferredLanguage: string },
  ask: vi.fn(async (..._a: unknown[]) => ({ id: "q1", status: "approved", piiStripped: true })),
  list: vi.fn(async (..._a: unknown[]) => ({ items: [], nextCursor: null, total: 0 })),
  rate: vi.fn(async (..._a: unknown[]) => true),
  limited: vi.fn(async (..._a: unknown[]) => null as Response | null),
}));
vi.mock("@cnote/next-kit", () => ({ currentSession: async () => h.session, runAction: async (fn: () => Promise<unknown>) => { try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: (e as Error).message }; } } }));
vi.mock("@cnote/reviews", () => ({ askQuestion: h.ask, listPublicQuestions: h.list }));
vi.mock("@cnote/core", async (orig) => ({ ...(await orig<typeof import("@cnote/core")>()), rateLimit: h.rate }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }) }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/request-locale", () => ({ getRequestLocale: async () => "en" }));
vi.mock("@/i18n/errors", () => ({ runLocalized: async (fn: () => Promise<unknown>) => { try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: (e as Error).message }; } } }));
vi.mock("@/features/search/api-guard", () => ({ limited: h.limited }));
vi.mock("@/features/reviews/actions", () => ({ reactAction: async () => ({ ok: true, data: { changed: true } }) }));
vi.mock("@/features/qa/actions", () => ({ askQuestionAction: async () => null }));

import { GET } from "@/app/api/qa/[id]/route";
import { faqLd } from "@/lib/schema";
import { QaList } from "@/features/qa/qa-list";

const LISTING = "0b7a5a0e-6a43-4f6c-9b7e-6e1b5a4b9c11";
const item = (n: number) => ({
  id: `q${n}`, body: `Is a GST invoice provided for order ${n}?`, authorName: "Buyer", askedAt: "2026-09-01T10:00:00.000Z",
  answer: { id: `a${n}`, body: `Yes, invoice ${n} is provided.`, answeredAt: "2026-09-02T10:00:00.000Z", sellerName: "Sharma Textiles", helpfulCount: 2 },
});
const render = (locale: "en" | "hi", page: { items: ReturnType<typeof item>[]; nextCursor: string | null; total: number }) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi}>
      <QaList listingId={LISTING} initial={page} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  h.session = null;
  h.ask.mockClear();
  h.list.mockClear();
  h.rate.mockReset();
  h.rate.mockResolvedValue(true);
  h.limited.mockReset();
  h.limited.mockResolvedValue(null);
});

describe("faqLd", () => {
  it("is null without answered questions and otherwise a FAQPage of Question/Answer pairs", () => {
    expect(faqLd([])).toBeNull();
    const ld = faqLd([{ question: "Q?", answer: "A.", date: "2026-09-01" }]) as { "@type": string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity[0]).toMatchObject({ "@type": "Question", name: "Q?", acceptedAnswer: { "@type": "Answer", text: "A." } });
  });
});

describe("QaList", () => {
  it("renders answered questions server-side with a labelled search, counts and per-answer actions", () => {
    const html = render("en", { items: [item(1), item(2)], nextCursor: "2", total: 7 });
    expect(html).toContain("Is a GST invoice provided for order 1?");
    expect(html).toContain("Yes, invoice 2 is provided.");
    expect(html).toContain("Answer from Sharma Textiles");
    expect(html).toContain('role="search"');
    expect(html).toMatch(/<label[^>]*>Search questions and answers<\/label>/);
    expect(html).toContain("7 answered questions");
    expect(html).toContain("Show more questions");
    expect(html).toContain("Helpful (2)");
    expect(html).toContain('aria-live="polite"');
  });

  it("shows an empty state (no search box) and renders in Hindi", () => {
    const empty = render("en", { items: [], nextCursor: null, total: 0 });
    expect(empty).toContain("No answered questions yet");
    expect(empty).not.toContain('role="search"');
    const hindi = render("hi", { items: [item(1)], nextCursor: null, total: 1 });
    expect(hindi).toContain("प्रश्न और उत्तर खोजें");
    expect(hindi).toContain("उपयोगी (2)");
    expect(hindi).not.toContain("Show more questions");
  });
});

describe("GET /api/qa/[id]", () => {
  const call = (id: string, qs = "") => GET(new Request(`http://x/api/qa/${id}${qs}`) as never, { params: Promise.resolve({ id }) } as never);

  it("404s on a malformed id", async () => {
    expect((await call("nope")).status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("serves browsable pages from the CDN-cacheable path and keeps searches private + rate limited", async () => {
    const page = await call(LISTING, "?cursor=5");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toContain("s-maxage=60");
    expect(h.limited).not.toHaveBeenCalled();
    expect(h.list).toHaveBeenCalledWith(LISTING, { q: null, cursor: "5" });

    const search = await call(LISTING, "?q=gst");
    expect(search.headers.get("cache-control")).toBe("private, no-store");
    expect(h.limited).toHaveBeenCalledWith(expect.anything(), "qa-search", 30, 60);

    h.limited.mockResolvedValueOnce(new Response("{}", { status: 429 }));
    expect((await call(LISTING, "?q=gst")).status).toBe(429);
  });

  it("503s when the module is down", async () => {
    h.list.mockRejectedValueOnce(new Error("db"));
    expect((await call(LISTING)).status).toBe(503);
  });
});

describe("askQuestionAction", () => {
  const form = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.set(k, v), f), new FormData());
  it("asks as the signed-in person with a per-IP limit; signed-out gets a sign-in prompt", async () => {
    const { askQuestionAction } = await vi.importActual<typeof import("@/features/qa/actions")>("@/features/qa/actions");
    expect(await askQuestionAction(null, form({ listingId: LISTING, body: "Anything?" }))).toMatchObject({ ok: false, error: "signIn" });
    expect(h.ask).not.toHaveBeenCalled();

    h.session = { personId: "p1", business: null, preferredLanguage: "hi" };
    const ok = await askQuestionAction(null, form({ listingId: LISTING, body: "What is the lead time for 500 pcs?" }));
    expect(ok).toEqual({ ok: true, data: { status: "approved", piiStripped: true } });
    expect(h.ask).toHaveBeenCalledWith({ personId: "p1", businessId: null }, LISTING, { body: "What is the lead time for 500 pcs?", language: "hi" });
    expect(h.rate).toHaveBeenCalledWith("qa:ask:ip:203.0.113.9", 20, 3600);

    h.rate.mockResolvedValueOnce(false);
    expect(await askQuestionAction(null, form({ listingId: LISTING, body: "Another question here?" }))).toMatchObject({ ok: false });
    expect(h.ask).toHaveBeenCalledTimes(1);
    expect(await askQuestionAction(null, form({ listingId: "bad", body: "Another question here?" }))).toMatchObject({ ok: false });
  });
});
