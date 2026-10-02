import path from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildCsp, EMBED_FRAME_ORIGINS as CSP_FRAME_ORIGINS } from "@cnote/security";
import { EMBED_FRAME_ORIGINS, embedSpec } from "@cnote/storefront/document";
import { findIframes, findUngatedIframes, isThirdPartySrc, read, sourceFiles } from "@cnote/consent/testing";
import en from "../messages/en.json";
import hi from "../messages/hi.json";
import { ConsentGate, GateView, gateOpen } from "@/features/consent/consent-gate";
import { CONSENT_POLICY_VERSION, serializeConsent, type ConsentState } from "@/features/consent/state";
import { StoreEmbed } from "@/features/storefront/embed";

const render = (node: React.ReactNode, locale: "en" | "hi" = "en") =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : hi} timeZone="Asia/Kolkata">
      {node}
    </NextIntlClientProvider>,
  );
const NOW = Date.parse("2026-10-02T00:00:00Z");
const state = (over: Partial<ConsentState> = {}): ConsentState => ({ version: CONSENT_POLICY_VERSION, id: "a".repeat(32), analytics: false, marketing: false, functional: false, gpc: false, at: Math.floor(NOW / 1000) - 60, ...over });

describe("ConsentGate placeholder (nothing from the provider before consent)", () => {
  const html = render(
    <ConsentGate category="marketing" provider="YouTube">
      <iframe src="https://www.youtube-nocookie.com/embed/x" title="video" />
    </ConsentGate>,
  );
  it("names the provider, warns about cookies, and offers Load it and Change cookie settings as real buttons", () => {
    expect(html).toContain("This content is from YouTube, which may set cookies.");
    const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1]!, text: m[2]!.replace(/<[^>]*>/g, "") }));
    expect(buttons.map((b) => b.text)).toEqual(["Load it", "Change cookie settings"]);
    for (const b of buttons) expect(b.attrs).toContain('type="button"');
    expect(html).toMatch(/min-h-11/); // 44px touch targets
  });
  it("is a labelled group (the label is the sentence), and never renders the embedded frame", () => {
    const labelled = /role="group"[^>]*aria-labelledby="([^"]+)"/.exec(html);
    expect(labelled).not.toBeNull();
    expect(html).toContain(`id="${labelled![1]}"`);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toContain("youtube-nocookie");
  });
  it("explains that Load it is for this item only and leaves cookie settings alone", () => {
    expect(html).toContain("shows only this item");
    expect(html).toContain("cookie settings stay as they are");
  });
  it("is localised (Hindi)", () => {
    const h = render(<ConsentGate category="functional" provider="OpenStreetMap"><i /></ConsentGate>, "hi");
    expect(h).toContain("OpenStreetMap");
    expect(h).toContain("इसे लोड करें");
    expect(h).toContain("कुकी सेटिंग बदलें");
  });
  it("uses the storefront classes when given them (the buyer-web defaults otherwise)", () => {
    const sf = render(<ConsentGate category="marketing" provider="YouTube" classes={{ root: "sf-embed-gate", primary: "sf-btn", secondary: "sf-btn sf-btn-ghost" }}><i /></ConsentGate>);
    expect(sf).toContain('class="sf-embed-gate"');
    expect(sf).toContain('class="sf-btn sf-btn-ghost"');
  });
});

describe("GateView and gateOpen", () => {
  it("renders the content once open, with no placeholder", () => {
    const open = render(<GateView open provider="YouTube"><iframe src="https://www.youtube-nocookie.com/embed/x" title="video" /></GateView>);
    expect(open).toContain("<iframe");
    expect(open).not.toContain("This content is from");
    expect(open).not.toContain("Load it");
    expect(render(<GateView open={false} provider="YouTube"><iframe title="x" /></GateView>)).not.toContain("<iframe");
  });
  it("opens only on a valid grant of exactly that category", () => {
    const raw = (s: Partial<ConsentState>) => serializeConsent(state(s));
    expect(gateOpen(null, "marketing", NOW)).toBe(false); // hydrating
    expect(gateOpen("", "marketing", NOW)).toBe(false); // no choice yet
    expect(gateOpen(raw({}), "marketing", NOW)).toBe(false); // rejected
    expect(gateOpen(raw({ marketing: true }), "marketing", NOW)).toBe(true);
    expect(gateOpen(raw({ marketing: true }), "functional", NOW)).toBe(false); // another category's grant does not unlock it
    expect(gateOpen(raw({ analytics: true }), "analytics", NOW)).toBe(true);
    expect(gateOpen(raw({ functional: true }), "functional", NOW)).toBe(true);
    expect(gateOpen(raw({ marketing: true, version: CONSENT_POLICY_VERSION - 1 }), "marketing", NOW)).toBe(false); // older policy: ask again
    expect(gateOpen(raw({ marketing: true, at: Math.floor(NOW / 1000) - 400 * 86_400 }), "marketing", NOW)).toBe(false); // expired
    expect(gateOpen("garbage", "marketing", NOW)).toBe(false);
  });
});

describe("StoreEmbed (storefront video / map block)", () => {
  const yt = embedSpec({ kind: "youtube", videoId: "dQw4w9WgXcQ" });
  const map = embedSpec({ kind: "map", lat: 18.52, lng: 73.85, zoom: 14 });
  it("shows only the placeholder before consent: no iframe, no provider URL in the markup", () => {
    const a = render(<StoreEmbed {...yt} title="Our workshop" />);
    expect(a).toContain("This content is from YouTube, which may set cookies.");
    expect(a).toContain("sf-embed-gate");
    expect(a).not.toMatch(/<iframe|youtube-nocookie|dQw4w9WgXcQ/);
    const b = render(<StoreEmbed {...map} title="Find us" />);
    expect(b).toContain("This content is from OpenStreetMap, which may set cookies.");
    expect(b).not.toMatch(/<iframe|openstreetmap\.org/);
  });
  it("gates video on marketing and the plain map on functional", () => {
    expect(yt.category).toBe("marketing");
    expect(map.category).toBe("functional");
  });
});

describe("CSP frame-src allows only the embed hosts the storefront can produce", () => {
  it("security's list and storefront's list are the same", () => {
    expect([...CSP_FRAME_ORIGINS]).toEqual([...EMBED_FRAME_ORIGINS]);
  });
  it("every iframe URL the storefront builds is inside the web CSP, and the CSP frames nothing else", () => {
    const csp = buildCsp({ app: "web", nonce: "n", env: { NODE_ENV: "production" } });
    const frame = csp.split("; ").find((d) => d.startsWith("frame-src "))!.split(" ").slice(1);
    expect(frame.sort()).toEqual([...EMBED_FRAME_ORIGINS].sort());
    for (const s of [embedSpec({ kind: "youtube", videoId: "dQw4w9WgXcQ" }), embedSpec({ kind: "map", lat: 1, lng: 2, zoom: 5 })]) expect(frame).toContain(new URL(s.src).origin);
  });
});

describe("no third-party iframe outside ConsentGate", () => {
  const REPO = path.join(__dirname, "..", "..", "..");
  const roots = ["apps/web/src", "apps/seller/src", "apps/admin/src", "apps/studio/src", "apps/api/src", "packages"].map((r) => path.join(REPO, r));
  // The scanner itself mentions the iframe pattern in its regexes.
  const files = roots.flatMap((r) => (r.endsWith("packages") ? sourceFilesOfPackages(r) : sourceFiles(r))).filter((f) => !f.endsWith(path.join("consent", "src", "testing.ts")));

  function sourceFilesOfPackages(dir: string): string[] {
    // every package's src (not tests, not node_modules)
    return sourceFiles(dir).filter((f) => f.split(path.sep).includes("src"));
  }

  it("scans a meaningful number of files (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((f) => f.endsWith(path.join("features", "storefront", "embed.tsx")))).toBe(true);
  });

  it("every `<iframe` with a third-party or dynamic src is inside <ConsentGate>", () => {
    const offenders = files.flatMap((f) => findUngatedIframes(read(f)).map((i) => `${path.relative(REPO, f)}:${i.line} (${i.src})`));
    expect(offenders, "a third-party iframe must be wrapped in <ConsentGate category=... provider=...> (apps/web/src/features/consent/consent-gate.tsx)").toEqual([]);
  });

  it("the only third-party frame in the codebase is the storefront embed; the admin preview is a sandboxed srcDoc", () => {
    const frames = files.flatMap((f) => findIframes(read(f)).filter((i) => isThirdPartySrc(i.src)).map(() => path.relative(REPO, f).split(path.sep).join("/")));
    expect(frames).toEqual(["apps/web/src/features/storefront/embed.tsx"]);
    const srcDocs = files.flatMap((f) => findIframes(read(f)).filter((i) => i.src === null).map(() => path.relative(REPO, f).split(path.sep).join("/")));
    expect(srcDocs).toEqual(["apps/admin/src/features/templates/shared.tsx"]);
  });

  it("the storefront renderer package itself never emits an iframe (it hands an Embed component the spec)", () => {
    const pkg = sourceFiles(path.join(REPO, "packages/storefront/src"));
    expect(pkg.flatMap((f) => findIframes(read(f)))).toEqual([]);
  });
});
