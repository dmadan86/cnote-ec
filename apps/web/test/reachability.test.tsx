import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ record: vi.fn(async (...a: string[]) => (a.length ? "responded" : "responded")), redirect: vi.fn((...a: string[]) => { void a; throw new Error("NEXT_REDIRECT"); }) }));
vi.mock("@cnote/enquiry", () => ({ recordReachabilityResponse: h.record }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("next-intl/server", async () => {
  const en = (await import("../messages/en.reachability.json")).default as { reachability: Record<string, string> };
  const hi = (await import("../messages/hi.reachability.json")).default as { reachability: Record<string, string> };
  return { getTranslations: async ({ locale }: { locale: string }) => (k: string) => (locale === "hi" ? hi : en).reachability[k] };
});

import Page, { metadata } from "@/app/r/[token]/page";
import { confirmReachabilityAction } from "@/app/r/[token]/actions";

const TOKEN = "abcdefghijklmnopqrstuvwx";
const render = async (sp: { s?: string; l?: string } = {}) => renderToStaticMarkup(await Page({ params: Promise.resolve({ token: TOKEN }), searchParams: Promise.resolve(sp) }));

beforeEach(() => { h.record.mockClear(); h.redirect.mockClear(); });

describe("/r/[token] buyer reachability page", () => {
  it("GET only renders a confirm form (POST server action); it never records a response", async () => {
    const html = await render();
    expect(h.record).not.toHaveBeenCalled();
    expect(html).toContain("Yes, I still need this");
    expect(html).toContain('type="submit"');
    expect(html).toContain(`value="${TOKEN}"`);
    expect(html).toMatch(/<h1[^>]*>Do you still need this\?/);
    expect(metadata.robots).toMatchObject({ index: false });
    const dir = fileURLToPath(new URL("../src/app/r/[token]/", import.meta.url));
    expect(existsSync(`${dir}route.ts`)).toBe(false); // no GET handler that could confirm
  });

  it("renders thanks, expired and Hindi states with lang attributes and no form", async () => {
    const done = await render({ s: "responded" });
    expect(done).toContain("Thanks, the supplier will contact you");
    expect(done).not.toContain("<form");
    expect(await render({ s: "expired" })).toContain("This link has expired");
    expect(await render({ s: "not_found" })).toContain("This link has expired");
    const hi = await render({ l: "hi" });
    expect(hi).toContain('lang="hi"');
    expect(hi).toContain("हाँ, मुझे अब भी चाहिए");
  });

  it("the confirm action records once and redirects to the result page", async () => {
    const fd = new FormData();
    fd.set("token", TOKEN);
    fd.set("lang", "hi");
    await expect(confirmReachabilityAction(fd)).rejects.toThrow("NEXT_REDIRECT");
    expect(h.record).toHaveBeenCalledWith(TOKEN);
    expect(h.redirect).toHaveBeenCalledWith(`/r/${TOKEN}?s=responded&l=hi`);
  });
});
