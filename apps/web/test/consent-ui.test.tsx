import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import hi from "../messages/hi.json";
import { ConsentBannerView } from "@/features/consent/banner";
import { CookieTable } from "@/features/consent/cookie-table";
import { PreferencesDialog } from "@/features/consent/preferences-dialog";
import { CATEGORIES, entriesOf } from "@/features/consent/registry";
import { CookieSettingsButton } from "@/features/consent/settings-button";
import { CONSENT_POLICY_VERSION, type ConsentState } from "@/features/consent/state";
import { SITE_NAME } from "@/features/shell/site";

const render = (node: React.ReactNode, locale: "en" | "hi" = "en") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi}>
      {node}
    </NextIntlClientProvider>,
  );
const noop = () => undefined;
/** Text content of rendered markup (strips tags until none are left, so nested fragments can't reassemble a tag). */
const textOf = (markup: string) => {
  let prev: string;
  let out = markup;
  do {
    prev = out;
    out = out.replace(/<[^>]*>?/g, "");
  } while (out !== prev);
  return out.trim();
};
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1]!, text: textOf(m[2]!), cls: /class="([^"]*)"/.exec(m[1]!)?.[1] ?? "" }));

describe("consent banner (first layer)", () => {
  const html = render(<ConsentBannerView onAccept={noop} onReject={noop} onCustomise={noop} />);
  it("is a non-modal labelled region, not a dialog, naming the data fiduciary and linking the cookie policy", () => {
    expect(html).toMatch(/<section[^>]*aria-label="Cookie notice"/);
    expect(html).not.toMatch(/role="dialog"|aria-modal/);
    expect(html).toContain(SITE_NAME);
    expect(html).toContain("data fiduciary");
    expect(html).toMatch(/<a[^>]*href="\/cookies"[^>]*>Cookie policy<\/a>/);
  });
  it("offers Accept all, Reject all and Customise on the first layer with identical styling (equal prominence)", () => {
    const b = buttons(html);
    expect(b.map((x) => x.text)).toEqual(["Accept all", "Reject all", "Customise"]);
    expect(new Set(b.map((x) => x.cls)).size).toBe(1);
    expect(b[0]!.cls).toMatch(/min-h-11/); // 44px touch target
    for (const x of b) expect(x.attrs).toContain('type="button"');
  });
  it("renders hidden (kept mounted) while the preferences dialog is open, so the two never show together", () => {
    expect(render(<ConsentBannerView onAccept={noop} onReject={noop} onCustomise={noop} hidden />)).toMatch(/<section[^>]*\shidden=""/);
    expect(html).not.toMatch(/<section[^>]*\shidden/);
  });
  it("is localised (Hindi)", () => {
    const h = render(<ConsentBannerView onAccept={noop} onReject={noop} onCustomise={noop} />, "hi");
    expect(h).toContain("सभी स्वीकार करें");
    expect(h).toContain("सभी अस्वीकार करें");
    expect(h).toContain("कुकी नीति");
  });
});

describe("preferences dialog (second layer)", () => {
  const props = { open: true, onClose: noop, initial: null, gpc: false, onAcceptAll: noop, onRejectAll: noop, onSave: noop };
  it("is a native <dialog> labelled by its heading with the three categories as accordions", () => {
    const html = render(<PreferencesDialog {...props} />);
    expect(html).toMatch(/<dialog[^>]*aria-labelledby="consent-dialog-title"/);
    expect(html).toMatch(/<h2[^>]*id="consent-dialog-title"[^>]*>Cookie preferences<\/h2>/);
    for (const c of ["Strictly necessary", "Analytics", "Marketing and attribution", "Preferences and personalisation"]) expect(html).toContain(c);
    expect((html.match(/aria-expanded="false"/g) ?? []).length).toBe(4);
    expect((html.match(/aria-controls=/g) ?? []).length).toBe(4);
    expect(html).toContain("Always active");
  });
  it("has role=switch toggles for analytics, marketing and functional, all OFF by default (nothing pre-ticked), with visible state text and names", () => {
    const html = render(<PreferencesDialog {...props} />);
    const sw = buttons(html).filter((b) => b.attrs.includes('role="switch"'));
    expect(sw).toHaveLength(3);
    for (const s of sw) {
      expect(s.attrs).toContain('aria-checked="false"');
      expect(s.attrs).toMatch(/aria-labelledby="[^"]+"/);
      expect(s.cls).toMatch(/min-h-11/);
      expect(s.text).toBe("Off");
    }
    expect(html).not.toContain("Global Privacy Control");
  });
  it("reflects a stored choice and offers Accept all / Reject all / Save choices with equal styling", () => {
    const initial: ConsentState = { version: CONSENT_POLICY_VERSION, id: "d".repeat(32), analytics: true, marketing: false, functional: false, gpc: false, at: 1 };
    const html = render(<PreferencesDialog {...props} initial={initial} />);
    const sw = buttons(html).filter((b) => b.attrs.includes('role="switch"'));
    expect(sw.map((s) => /aria-checked="(\w+)"/.exec(s.attrs)![1])).toEqual(["true", "false", "false"]);
    expect(sw.map((s) => s.text)).toEqual(["On", "Off", "Off"]);
    const foot = buttons(html).filter((b) => ["Accept all", "Reject all", "Save choices"].includes(b.text));
    expect(foot.map((b) => b.text)).toEqual(["Accept all", "Reject all", "Save choices"]);
    expect(new Set(foot.map((b) => b.cls)).size).toBe(1);
    expect(html).toMatch(/aria-label="Close"/);
  });
  it("shows the Global Privacy Control note next to the marketing switch when the signal is on, and the switch stays operable", () => {
    const html = render(<PreferencesDialog {...props} gpc />);
    expect(html).toContain("Your browser&#x27;s Global Privacy Control signal is on");
    const marketing = buttons(html).filter((b) => b.attrs.includes('role="switch"'))[1]!;
    expect(marketing.attrs).toContain('aria-checked="false"');
    expect(marketing.attrs).toMatch(/aria-describedby="[^"]+ [^"]+"/); // description + GPC note
    expect(marketing.attrs).not.toContain("disabled");
  });
  it("renders no content while closed (the <dialog> shell stays mounted so focus can return to the opener)", () => {
    const html = render(<PreferencesDialog {...props} open={false} />);
    expect(html).toMatch(/<dialog[^>]*><\/dialog>/);
  });
});

describe("cookie table (dialog + policy page)", () => {
  it("renders every registry row of a category with name, provider, purpose and duration in a labelled, focusable scroll region", () => {
    const html = render(<CookieTable category="marketing" label="Marketing and attribution" />);
    expect(html).toMatch(/role="region"[^>]*aria-label="Marketing and attribution: cookies and storage keys"[^>]*tabindex="0"|tabindex="0"[^>]*role="region"/);
    for (const c of ["Name", "Provider", "Purpose", "Duration"]) expect(html).toContain(`>${c}</th>`);
    for (const e of entriesOf("marketing")) expect(html).toContain(e.name);
    expect(html).toContain("30 days");
    expect(html).toContain("7 days");
    expect(html).toContain("Session storage");
    expect(html).toContain("Until you clear it");
  });
  it("names Microsoft Clarity as the provider of the analytics cookies, and localises to Hindi", () => {
    expect(render(<CookieTable category="analytics" label="A" />)).toContain("Microsoft Clarity");
    const h = render(<CookieTable category="necessary" label="ज़रूरी" />, "hi");
    expect(h).toContain("cnote_consent");
    expect(h).toContain("30 दिन");
    expect(CATEGORIES).toHaveLength(4);
  });
});

describe("cookie settings entry", () => {
  it("is a plain button (opens the dialog, no reload, no link)", () => {
    const html = renderToStaticMarkup(<CookieSettingsButton label="Cookie settings" className="x" />);
    expect(html).toBe('<button type="button" class="x">Cookie settings</button>');
  });
});
