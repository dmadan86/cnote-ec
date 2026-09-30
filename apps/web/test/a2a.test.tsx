import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MandateChangeView, MandateView, NegotiationSummary, NegotiationView } from "@cnote/a2a";
import en from "../messages/en.a2a.json";
import { endOfDayIst, parseAutoOn, parseCreate, parseEdit } from "@/features/a2a/form-parse";
import { A2A_KEYS, fmt, paiseToInput, parseRupees, rupees, type A2aLabels } from "@/features/a2a/labels";

// Client components import server actions (which pull in the whole domain layer); the markup tests only need inert stand-ins.
vi.mock("@/features/a2a/actions", () => ({
  createMandateAction: vi.fn(), updateMandateAction: vi.fn(), mandateStatusAction: vi.fn(), autoAcceptAction: vi.fn(), negotiationAction: vi.fn(),
}));
const { MandateForm } = await import("@/features/a2a/mandate-form");
const { AutoAcceptControl, MandateStatusControls } = await import("@/features/a2a/mandate-controls");
const { NegotiationActions } = await import("@/features/a2a/negotiation-controls");
const { ActivityList, ConfirmList, HistoryTable, MandateList, Transcript } = await import("@/features/a2a/views");

const t = en.a2a as unknown as A2aLabels;
const LOCALES = ["hi", "kn", "ta", "te", "mr", "gu", "bn"] as const;
type Json = { [k: string]: Json | string };
const ph = (m: string) => [...m.matchAll(/\{(\w+)/g)].map((x) => x[1]!).sort().join();

describe("a2a catalogue", () => {
  it("A2A_KEYS is exactly the keys of en.a2a.json", () => {
    expect([...A2A_KEYS].sort()).toEqual(Object.keys(en.a2a).sort());
  });
  it.each(LOCALES)("%s has exactly the keys and placeholders of en, is marked machine-drafted and is translated", (loc) => {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "messages", `${loc}.a2a.json`), "utf8")) as Json;
    expect(Object.keys(raw).filter((k) => !k.startsWith("_"))).toEqual(["a2a"]);
    expect(raw._meta).toEqual({ review: "machine-drafted; needs native review" });
    const L = raw.a2a as Record<string, string>;
    expect(Object.keys(L).sort()).toEqual(Object.keys(en.a2a).sort());
    for (const k of Object.keys(en.a2a)) {
      expect(ph(L[k]!), k).toBe(ph((en.a2a as Record<string, string>)[k]!));
      if (/[A-Za-z]/.test((en.a2a as Record<string, string>)[k]!.replace(/\{[^}]*\}/g, ""))) expect(L[k], k).not.toBe((en.a2a as Record<string, string>)[k]);
    }
  });
  it("the permanent commitment line says nothing is committed until the buyer confirms", () => {
    expect(t.commitNote).toBe("Nothing is committed until you confirm");
  });
});

describe("a2a money (integer maths on strings)", () => {
  it("converts rupees to paise without float drift", () => {
    expect(parseRupees("1.15")).toBe(115);
    expect(parseRupees("1,250")).toBe(125000);
    expect(parseRupees("1250.5")).toBe(125050);
    expect(parseRupees("0.07")).toBe(7);
    expect(parseRupees("19.99")).toBe(1999);
    expect(parseRupees("8.20")).toBe(820);
    for (const bad of ["", "0", "0.00", "-5", "1e3", "12.345", "abc", "1.", ".5", "1 000"]) expect(parseRupees(bad), bad).toBeNull();
  });
  it("round-trips paise to input text and display", () => {
    expect(paiseToInput(125000)).toBe("1250");
    expect(paiseToInput(125050)).toBe("1250.50");
    expect(paiseToInput(7)).toBe("0.07");
    expect(rupees(125050)).toBe("₹1,250.50");
    expect(rupees(12345600)).toBe("₹1,23,456");
  });
  it("fmt substitutes placeholders and leaves unknown ones", () => {
    expect(fmt("{a} of {b} {c}", { a: 1, b: "x" })).toBe("1 of x {c}");
  });
});

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const base = { name: "Monthly boxes", title: "Corrugated boxes", requirement: "3 ply kraft boxes, 12x10x8 inch", quantity: "5000", unit: "pcs", max: "20.50", target: "18", lead: "10", sellers: "", recurMode: "once", expiry: "" };

describe("a2a form parsing", () => {
  it("auto-accept is off unless explicitly switched on, and opt-in is mandatory", () => {
    const missing = parseCreate(fd(base));
    expect(missing).toMatchObject({ ok: false, errors: { optIn: "errConsent" } });
    const ok = parseCreate(fd({ ...base, optIn: "on" }));
    expect(ok).toMatchObject({ ok: true, value: { autoAccept: false, autoAcceptConsent: false, autoAcceptLimitPaise: null, limitPricePaise: 2050, targetPricePaise: 1800, quantity: 5000 } });
  });
  it("turning auto-accept on needs consent and a ceiling not above the maximum price", () => {
    const on = { ...base, optIn: "on", autoAccept: "on" };
    expect(parseCreate(fd(on))).toMatchObject({ ok: false, errors: { autoConsent: "errConsent", autoLimit: "errMoney" } });
    expect(parseCreate(fd({ ...on, autoConsent: "on", autoLimit: "21" }))).toMatchObject({ ok: false, errors: { autoLimit: "errCeiling" } });
    expect(parseCreate(fd({ ...on, autoConsent: "on", autoLimit: "20.50" }))).toMatchObject({ ok: true, value: { autoAccept: true, autoAcceptConsent: true, autoAcceptLimitPaise: 2050 } });
  });
  it("validates recurrence, expiry and approved seller ids", () => {
    const id = "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b";
    expect(parseEdit(fd({ ...base, recurMode: "every", recurDays: "0" }))).toMatchObject({ ok: false, errors: { recurDays: "errInt" } });
    expect(parseEdit(fd({ ...base, expiry: "31/12/2026" }))).toMatchObject({ ok: false, errors: { expiry: "errDate" } });
    expect(parseEdit(fd({ ...base, sellers: "nope" }))).toMatchObject({ ok: false, errors: { sellers: "errSellers" } });
    expect(parseEdit(fd({ ...base, recurMode: "every", recurDays: "30", expiry: "2027-01-31", sellers: `${id}\n${id.toUpperCase()}` }))).toMatchObject({
      ok: true, value: { recurrenceDays: 30, expiresAt: "2027-01-31T23:59:59+05:30", approvedSellerIds: [id] },
    });
    expect(endOfDayIst("2027-02-30")).toBeNull();
  });
  it("enabling auto-accept later is bounded by the mandate's maximum price", () => {
    expect(parseAutoOn(fd({ autoConsent: "on", autoLimit: "30" }), 2050)).toMatchObject({ ok: false, errors: { autoLimit: "errCeiling" } });
    expect(parseAutoOn(fd({ autoLimit: "10" }), 2050)).toMatchObject({ ok: false, errors: { autoConsent: "errConsent" } });
    expect(parseAutoOn(fd({ autoConsent: "on", autoLimit: "10" }), 2050)).toEqual({ ok: true, limitPricePaise: 1000 });
  });
});

// ---- markup contracts (the repo renders with react-dom/server; there is no browser in unit tests)
const mandate: MandateView = {
  id: "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b", businessId: "b1", side: "buyer", status: "active", name: "Monthly boxes", categorySlug: null, title: "Corrugated boxes", requirement: "x",
  deliveryCity: null, deliveryPincode: null, deliveryTerms: null, paymentTerms: null, quantity: 5000, unit: "pcs", targetPricePaise: 1800, limitPricePaise: 2050, maxLeadTimeDays: 10,
  maxDiscountPct: null, capacityQty: null, priceBookId: null, approvedSellerIds: [], maxRounds: 6, recurrenceDays: 30, nextRunAt: "2027-01-01T00:00:00.000Z", lastRunAt: null,
  expiresAt: null, autoAccept: false, autoAcceptLimitPaise: null, consentedAt: "2026-09-01T00:00:00.000Z", version: 1, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};
const neg = {
  id: "n1", status: "agreed", youAre: "buyer", admin: false, buyer: { businessId: "b1", name: "Me Traders" }, seller: { businessId: "s1", name: "Acme Packs" }, enquiryId: "e", matchId: "m",
  round: 2, maxRounds: 6, turn: null, lastOffer: null, agreed: { pricePaise: 1900, quantity: 5000, unit: "pcs", leadTimeDays: 7, deliveryTerms: "Ex-works", validUntil: "2026-10-05T00:00:00.000Z", paymentTerms: null },
  yourConfirmation: "pending", counterpartyConfirmed: false, buyerConfirmed: false, sellerConfirmed: false, canConfirm: true, yourLimits: null, external: false, flagged: false, quoteId: null,
  orderId: null, realiseError: null, expiresAt: "2026-10-01T00:00:00.000Z", createdAt: "2026-09-30T00:00:00.000Z", closedAt: null,
  messages: [
    { seq: 1, side: "buyer", type: "offer", offer: { pricePaise: 1800, quantity: 5000, unit: "pcs", leadTimeDays: 10, deliveryTerms: null, validUntil: "2026-10-05T00:00:00.000Z", paymentTerms: "30 days" }, actor: "agent", mine: true, createdAt: "2026-09-30T00:00:00.000Z" },
    { seq: 2, side: "seller", type: "counter", offer: { pricePaise: 1900, quantity: 5000, unit: "pcs", leadTimeDays: 7, deliveryTerms: "Ex-works", validUntil: "2026-10-05T00:00:00.000Z", paymentTerms: null }, actor: "external_agent", mine: false, createdAt: "2026-09-30T00:01:00.000Z" },
    { seq: 3, side: "buyer", type: "accept", offer: null, actor: "agent", mine: true, createdAt: "2026-09-30T00:02:00.000Z" },
  ],
} as unknown as NegotiationView;

/** Every visible form control has a programmatic label (WCAG 1.3.1 / 3.3.2) and every id is unique (4.1.1). */
function expectLabelled(html: string) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  expect(new Set(ids).size, "duplicate ids").toBe(ids.length);
  for (const m of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
    const attrs = m[2]!;
    if (/type="hidden"/.test(attrs)) continue;
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    const before = html.slice(0, m.index);
    const wrapped = before.lastIndexOf("<label") > before.lastIndexOf("</label>"); // control nested inside its <label>
    const labelled = !!id && new RegExp(`<label[^>]*for="${id}"`).test(html);
    expect(labelled || wrapped || /aria-label=/.test(attrs), `control without label: ${m[0]}`).toBe(true);
  }
  // describedby / controls targets exist
  for (const m of html.matchAll(/aria-describedby="([^"]+)"/g)) for (const id of m[1]!.split(" ")) if (!id.endsWith("-error") && !id.endsWith("-hint")) expect(ids).toContain(id);
}
const headingLevels = (html: string) => [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));

describe("a2a markup accessibility contracts", () => {
  it("the create form labels every control, hints via aria-describedby, keeps auto-accept unticked and has 44px targets", () => {
    const html = renderToStaticMarkup(<MandateForm mode="create" t={t} />);
    expectLabelled(html);
    expect(html).toMatch(/<form[^>]*aria-labelledby="mc-h"/);
    expect(html).toContain(">Create a buying mandate<");
    const tag = (name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)![0];
    expect(tag("autoAccept")).toContain('aria-expanded="false"');
    expect(tag("autoAccept")).not.toContain("checked");
    expect(html).not.toContain('name="autoLimit"'); // ceiling + consent only appear once auto-accept is ticked
    expect(tag("optIn")).toContain("required");
    expect(tag("optIn")).not.toContain("checked");
    expect(html).toMatch(/aria-describedby="mc-target-hint"/);
    expect(html).toContain("min-h-11");
    expect(html).toContain(t.commitNote);
    expect(html).toMatch(/aria-live="polite"/);
  });
  it("the edit form carries the mandate id and prefilled values", () => {
    const html = renderToStaticMarkup(<MandateForm mode="edit" t={t} defaults={{ id: mandate.id, name: mandate.name, title: "Corrugated boxes", requirement: "x", categorySlug: "", quantity: "5000", unit: "pcs", target: "18", max: "20.50", lead: "10", sellers: "", recurDays: 30, expiry: "" }} />);
    expectLabelled(html);
    expect(html).toContain(`name="id" value="${mandate.id}"`);
    expect(html).toContain('value="20.50"');
    expect(html).toContain(">Save changes<");
    expect(html).not.toContain('name="optIn"');
  });
  it("auto-accept off is one click (a single-button form with no extra fields)", () => {
    const html = renderToStaticMarkup(<AutoAcceptControl id={mandate.id} enabled limitLabel="₹20.50" maxHint={null} canChange t={t} />);
    expect(html).toContain("Auto-accept is on, up to ₹20.50 per unit.");
    expect(html).toContain('name="intent" value="off"');
    expect(html).toContain(">Turn auto-accept off<");
    expect(html).not.toContain('type="checkbox"');
    const off = renderToStaticMarkup(<AutoAcceptControl id={mandate.id} enabled={false} limitLabel={null} maxHint={null} canChange t={t} />);
    expect(off).toContain(t.autoIsOff);
    expect(off).toContain('aria-controls="ma-on"');
  });
  it("revoke needs a second explicit step and the status region is live", () => {
    const html = renderToStaticMarkup(<MandateStatusControls id={mandate.id} status="active" t={t} />);
    expect(html).toContain(">Pause<");
    expect(html).toContain(">Revoke<");
    expect(html).not.toContain(t.revokeWarn);
    expect(html).toContain('aria-live="polite"');
    expect(headingLevels(html)).toEqual([2]);
  });
  it("confirm and decline are shown only when the buyer can confirm", () => {
    const yes = renderToStaticMarkup(<NegotiationActions id="n1" canConfirm canRetry={false} canWithdraw={false} t={t} />);
    expect(yes).toContain(">Confirm deal<");
    expect(yes).toContain(">Decline<");
    const no = renderToStaticMarkup(<NegotiationActions id="n1" canConfirm={false} canRetry={false} canWithdraw={false} t={t} />);
    expect(no).not.toContain("Confirm deal");
    expect(no).toContain('aria-live="polite"');
    expect(renderToStaticMarkup(<NegotiationActions id="n1" canConfirm={false} canRetry canWithdraw={false} t={t} />)).toContain(">Try again<");
  });
  it("the transcript is a real table with caption, scoped headers, and a labelled focusable scroll region", () => {
    const html = renderToStaticMarkup(<Transcript n={neg} t={t} bcp47="en-IN" />);
    expect(html).toContain('<caption class="sr-only">Offers and replies in this negotiation, oldest first</caption>');
    for (const h of ["Who", "Type", "Price per unit", "Quantity", "Unit", "Lead time", "Terms", "Valid until"]) expect(html).toMatch(new RegExp(`<th scope="col"[^>]*>${h}</th>`));
    expect(html.replace(/<[^>]+>/g, "")).toContain("You (agent)");
    expect(html.replace(/<[^>]+>/g, "")).toContain("Acme Packs (connected agent)");
    expect(html).toContain("₹19");
    expect(html).toContain("Delivery: Ex-works");
    expect(html).toContain("Payment: 30 days");
    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("No terms in this message"); // accept row: text alternative for the dash
    expect(html).not.toMatch(/floor|ceiling|yourLimits/i);
  });
  it("lists use semantic lists, real links and text status (never colour alone)", () => {
    const html = renderToStaticMarkup(<MandateList mandates={[mandate, { ...mandate, id: "x2", autoAccept: true, status: "paused" }]} t={t} bcp47="en-IN" />);
    expect(html).toContain("<ul");
    expect(html).toContain("Active");
    expect(html).toContain("Paused");
    expect(html).toContain("Auto-accept off");
    expect(html).toContain("Auto-accept on");
    expect(html).toContain("₹20.50");
    expect(html).toContain(`href="/buyer/agents/mandates/${mandate.id}"`);
    expect(headingLevels(html).every((l) => l === 3)).toBe(true);
    expect(renderToStaticMarkup(<MandateList mandates={[]} t={t} bcp47="en-IN" />)).toContain(t.mandatesEmpty);

    const waiting = [{ id: "n1", counterparty: { businessId: "s1", name: "Acme Packs" }, agreedPricePaise: 1900 }] as unknown as NegotiationSummary[];
    const cl = renderToStaticMarkup(<ConfirmList items={waiting} t={t} />);
    expect(cl).toContain("Acme Packs: agreed at ₹19 per unit");
    expect(cl).toContain('href="/buyer/agents/negotiations/n1"');
    expect(cl).toContain('<span class="sr-only">: Acme Packs</span>');
    expect(renderToStaticMarkup(<ConfirmList items={[]} t={t} />)).toContain(t.confirmEmpty);
  });
  it("activity and history never leak English summaries and use time elements", () => {
    const act = renderToStaticMarkup(<ActivityList items={[{ id: "a1", action: "confirmed_auto", summary: "RAW ENGLISH SUMMARY", details: {}, mandateId: null, negotiationId: "n1", byAgent: true, createdAt: "2026-09-30T00:00:00.000Z" }]} t={t} bcp47="en-IN" />);
    expect(act).toContain("Deal confirmed");
    expect(act).toContain("by your agent");
    expect(act).toContain("<time");
    expect(act).not.toContain("RAW ENGLISH SUMMARY");
    const hist = renderToStaticMarkup(<HistoryTable changes={[{ id: "c1", version: 2, action: "auto_accept_off", actorKind: "human", byPerson: true, snapshot: mandate, createdAt: "2026-09-30T00:00:00.000Z" } as MandateChangeView]} t={t} bcp47="en-IN" />);
    expect(hist).toContain("<caption");
    expect(hist).toContain('scope="col"');
    expect(hist).toContain("Auto-accept turned off");
  });
});

describe("a2a routes", () => {
  it("live under the auth-gated /buyer prefix and never import counterparty-limit data", () => {
    const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
    for (const p of ["src/app/(app)/(dashboard)/buyer/agents/page.tsx", "src/app/(app)/(dashboard)/buyer/agents/mandates/[id]/page.tsx", "src/app/(app)/(dashboard)/buyer/agents/negotiations/[id]/page.tsx"]) {
      const src = read(p);
      expect(src).toContain("requireBusiness(");
      expect(src).not.toMatch(/sellerPrivate|buyerPrivate|adminGetNegotiation/);
    }
    expect(read("src/proxy.ts")).toContain('"/buyer"');
  });
});
