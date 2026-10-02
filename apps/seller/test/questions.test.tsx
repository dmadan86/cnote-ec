/* eslint-disable @typescript-eslint/no-unused-vars -- vi.fn signatures declare the call args the assertions read */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ answer: vi.fn(async (..._a: unknown[]) => ({ id: "a1", questionId: "q1", status: "approved", piiStripped: true })) }));
vi.mock("server-only", () => ({}));
vi.mock("@cnote/reviews", () => ({ answerQuestion: h.answer }));
vi.mock("@cnote/next-kit", () => ({
  actorOf: () => ({ personId: "p1", businessId: "b1" }),
  runAction: async (fn: () => Promise<unknown>) => { try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard", unstable_rethrow: (e: unknown) => { throw e; } }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/auth", () => ({ requireSeller: async () => ({ personId: "p1", business: { id: "b1" } }) }));
vi.mock("@/lib/run", () => ({ run: async (fn: () => Promise<unknown>) => { try { return { ok: true, data: await fn() }; } catch (e) { return { ok: false, error: (e as Error).message }; } } }));

import { answerQuestionAction } from "@/features/questions/actions";
import { NAV_ITEMS } from "@/features/shell/nav-items";
import { SidebarNav } from "@/features/shell/nav";

const ROOT = join(__dirname, "..");
const read = (f: string) => JSON.parse(readFileSync(join(ROOT, "messages", f), "utf8")) as Record<string, Record<string, unknown>>;
const ID = "6f1c0c5e-2a64-4bd8-9a55-0f2a53a3a111";
const form = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.set(k, v), f), new FormData());

beforeEach(() => h.answer.mockClear());

describe("seller Questions inbox", () => {
  it("is in the nav and protected by the proxy", () => {
    expect(NAV_ITEMS.some((i) => i.href === "/questions" && i.key === "questions")).toBe(true);
    expect(readFileSync(join(ROOT, "src/proxy.ts"), "utf8")).toContain('"/questions"');
  });

  it("shows an unanswered badge (with a screen-reader label) only when there are questions waiting", () => {
    const messages = { shell: { mainNav: "Main", nav: Object.fromEntries(NAV_ITEMS.map((i) => [i.key, i.key])), questionsUnanswered: "{count} unanswered" } };
    const render = (n: number) => renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages}><SidebarNav unanswered={n} /></NextIntlClientProvider>);
    const withBadge = render(3);
    expect(withBadge).toContain("3 unanswered");
    expect(withBadge).toContain('aria-hidden="true">3<');
    expect(render(0)).not.toContain("unanswered");
    expect(render(150)).toContain("99+");
  });

  it("answers as the signed-in seller's actor and reports whether contact details were removed", async () => {
    const res = await answerQuestionAction(null, form({ id: ID, body: "Yes, GST invoice is provided." }));
    expect(res).toEqual({ ok: true, data: { stripped: true } });
    expect(h.answer).toHaveBeenCalledWith({ personId: "p1", businessId: "b1" }, ID, { body: "Yes, GST invoice is provided." });
  });

  it("validates before reaching the module", async () => {
    expect((await answerQuestionAction(null, form({ id: ID, body: "x" }))).ok).toBe(false);
    expect((await answerQuestionAction(null, form({ id: "nope", body: "Fine answer" }))).ok).toBe(false);
    expect(h.answer).not.toHaveBeenCalled();
  });

  it("every translation key used by the page and form exists in English", () => {
    const en = read("en.questions.json").questions!;
    for (const f of ["src/app/(portal)/questions/page.tsx", "src/features/questions/answer-form.tsx", "src/features/questions/actions.ts"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/\bt\("(\w+)"/g)) expect(en, `${f}: ${m[1]}`).toHaveProperty(m[1]!);
    }
    expect(read("en.json").shell).toHaveProperty("questionsUnanswered");
  });
});
