import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { NextRequest } from "next/server";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LISTING = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
const h = vi.hoisted(() => ({
  session: null as null | { personId: string },
  contact: { unlocked: false } as Record<string, unknown>,
  recorded: [] as unknown[],
  recordError: null as null | Error,
}));
vi.mock("@cnote/next-kit", () => ({ currentSession: async () => h.session }));
vi.mock("@cnote/leadgen", () => ({
  CONTACT_CHANNELS: ["call", "whatsapp", "email", "enquiry"],
  getUnlockedSupplierContact: async () => h.contact,
  recordSupplierContacted: async (...a: unknown[]) => {
    if (h.recordError) throw h.recordError;
    h.recorded.push(a);
  },
}));

const { GET, POST } = await import("@/app/api/contact/[listingId]/route");
const ctx = (id: string) => ({ params: Promise.resolve({ listingId: id }) }) as never;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost/api/contact/${LISTING}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  h.session = null;
  h.contact = { unlocked: false };
  h.recorded = [];
  h.recordError = null;
});

describe("GET /api/contact/[listingId]", () => {
  it("answers locked and no-store for anonymous visitors, without ever reading contact data", async () => {
    h.contact = { unlocked: true, phone: "+919876543210" };
    const res = await GET(new NextRequest(`http://localhost/api/contact/${LISTING}`), ctx(LISTING));
    expect(await res.json()).toEqual({ unlocked: false });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
  });
  it("returns the details only for a signed-in buyer who unlocked, always private + no-store", async () => {
    h.session = { personId: "p1" };
    h.contact = { unlocked: true, phone: "+919876543210", whatsapp: "919876543210", email: null };
    const res = await GET(new NextRequest(`http://localhost/api/contact/${LISTING}`), ctx(LISTING));
    expect(await res.json()).toMatchObject({ unlocked: true, phone: "+919876543210" });
    expect(res.headers.get("cache-control")).toMatch(/private, no-store/);
    expect(res.headers.get("vary")).toBe("Cookie");
    h.contact = { unlocked: false };
    expect(await (await GET(new NextRequest(`http://localhost/api/contact/${LISTING}`), ctx(LISTING))).json()).toEqual({ unlocked: false });
  });
  it("404s a malformed listing id", async () => {
    expect((await GET(new NextRequest("http://localhost/api/contact/x"), ctx("x"))).status).toBe(404);
  });
});

describe("POST /api/contact/[listingId]", () => {
  it("needs a session, a known channel and the same origin", async () => {
    expect((await POST(post({ channel: "call" }), ctx(LISTING))).status).toBe(401);
    h.session = { personId: "p1" };
    expect((await POST(post({ channel: "sms" }), ctx(LISTING))).status).toBe(400);
    expect((await POST(post({ channel: "call" }, { origin: "https://evil.example" }), ctx(LISTING))).status).toBe(403);
    expect(h.recorded).toEqual([]);
  });
  it("logs the channel for a signed-in buyer", async () => {
    h.session = { personId: "p1" };
    const res = await POST(post({ channel: "whatsapp" }), ctx(LISTING));
    expect(res.status).toBe(200);
    expect(h.recorded).toEqual([["p1", LISTING, "whatsapp"]]);
  });
  it("refuses a contact the buyer never unlocked", async () => {
    h.session = { personId: "p1" };
    const { DomainError } = await import("@cnote/core");
    h.recordError = new DomainError("forbidden", "Contact this supplier first.");
    expect((await POST(post({ channel: "call" }), ctx(LISTING))).status).toBe(403);
  });
});

describe("SupplierContact on a static page", () => {
  it("server-renders only the unlock button: no number, no call/WhatsApp/email controls", async () => {
    vi.doMock("@/features/user-state/store", () => ({ useUserState: () => ({ status: "idle", signedIn: false }) }));
    vi.doMock("@/i18n/link", () => ({ LocaleLink: ({ children, ...p }: { children: React.ReactNode }) => <a {...p}>{children}</a> }));
    const { SupplierContact } = await import("@/features/contact/supplier-contact");
    const messages = JSON.parse(readFileSync(join(__dirname, "..", "messages", "en.convenience.json"), "utf8"));
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={messages}>
        <SupplierContact listingId={LISTING} listingTitle="Kraft Box">
          <button type="button">Contact seller</button>
        </SupplierContact>
      </NextIntlClientProvider>,
    );
    expect(html).toContain("Contact seller");
    expect(html).not.toMatch(/tel:|wa\.me|mailto:|\+91/);
    expect(html).not.toContain("supplier-contact");
  });
});
