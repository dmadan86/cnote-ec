import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { securityHeaders } from "@cnote/security";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { PWA_ICONS } from "@/features/pwa/manifest-data";
import { CACHEABLE_NAVIGATION_PREFIXES, classify, isCacheableNavigation, offlineFor, OFFLINE_PATHS, PRIVATE_PREFIXES, type SwRequestInfo, type SwStrategy } from "@/features/pwa/sw-rules";

const ORIGIN = "https://buyer.test";
const req = (over: Partial<SwRequestInfo> & { path?: string }): SwRequestInfo => ({
  method: "GET",
  url: `${ORIGIN}${over.path ?? "/"}`,
  mode: "cors",
  destination: "",
  origin: ORIGIN,
  ...over,
});
const nav = (path: string, method = "GET") => req({ path, mode: "navigate", destination: "document", method });

const CASES: [string, SwRequestInfo, SwStrategy][] = [
  ["home navigation is network first", nav("/"), "navigate"],
  ["localised help navigation", nav("/hi/help/buying/post-requirement"), "navigate"],
  ["search navigation", nav("/search?q=box"), "navigate"],
  ["fingerprinted static asset", req({ path: "/_next/static/chunks/app.js", destination: "script" }), "static"],
  ["static css", req({ path: "/_next/static/css/a.css", destination: "style" }), "static"],
  ["optimised image", req({ path: "/_next/image?url=%2Fa.png&w=640&q=75" }), "image"],
  ["plain image", req({ path: "/placeholders/box.svg", destination: "image" }), "image"],
  ["POST navigation is never handled", nav("/search", "POST"), "bypass"],
  ["server action POST", req({ path: "/rfq/new", method: "POST" }), "bypass"],
  ["api GET", req({ path: "/api/me" }), "bypass"],
  ["api exact", req({ path: "/api" }), "bypass"],
  ["auth route handler", req({ path: "/api/auth/refresh" }), "bypass"],
  ["sign-in page", nav("/signin"), "bypass"],
  ["sign-up page", nav("/signup"), "bypass"],
  ["account area", nav("/account/export"), "bypass"],
  ["buyer area", nav("/buyer/enquiries"), "bypass"],
  ["rfq form", nav("/rfq/new"), "bypass"],
  ["grievance form", nav("/grievance"), "bypass"],
  ["sponsored click redirect", nav("/ad/abc"), "bypass"],
  ["image under a private area", req({ path: "/account/avatar.png", destination: "image" }), "bypass"],
  ["cross-origin script", { ...req({ destination: "script" }), url: "https://www.clarity.ms/tag/x.js" }, "bypass"],
  ["cross-origin image", { ...req({ destination: "image" }), url: "https://cdn.example/a.png" }, "bypass"],
  ["range request (media)", req({ path: "/media/v/a.mp4", range: true }), "bypass"],
  ["the worker script itself", req({ path: "/sw.js" }), "bypass"],
  ["the manifest", req({ path: "/manifest.webmanifest" }), "bypass"],
  ["fetch() to a page route", req({ path: "/search?q=x" }), "bypass"],
  ["malformed url", { ...req({}), url: "::not a url::" }, "bypass"],
];

describe("service worker request rules", () => {
  it.each(CASES)("%s", (_name, info, expected) => {
    expect(classify(info)).toBe(expected);
  });

  it("never handles anything but GET", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]) {
      for (const path of ["/", "/help", "/_next/static/a.js", "/placeholders/a.png"]) expect(classify(req({ path, method, mode: "navigate", destination: "image" }))).toBe("bypass");
    }
  });

  it("never handles any private prefix, whatever the request type", () => {
    for (const p of PRIVATE_PREFIXES) {
      const path = p.endsWith("/") ? `${p}x` : `${p}/x`;
      expect(classify(nav(path)), path).toBe("bypass");
      expect(classify(req({ path, destination: "image" })), path).toBe("bypass");
      if (!p.endsWith("/")) expect(classify(nav(p)), p).toBe("bypass");
    }
  });

  it("caches last-good copies only of public help pages and the offline pages", () => {
    for (const ok of ["/help", "/help/buying", "/hi/help/safety/stay-safe", "/offline", "/hi/offline"]) expect(isCacheableNavigation(ok), ok).toBe(true);
    for (const no of ["/", "/search", "/hi", "/helpdesk", "/hi/helpful", "/account", "/p/abc"]) expect(isCacheableNavigation(no), no).toBe(false);
  });

  it("falls back to the offline page of the language being visited", () => {
    expect(offlineFor("/")).toBe("/offline");
    expect(offlineFor("/search")).toBe("/offline");
    expect(offlineFor("/hi")).toBe("/hi/offline");
    expect(offlineFor("/hi/c/packaging")).toBe("/hi/offline");
    expect(offlineFor("/history")).toBe("/offline"); // not the /hi prefix
  });
});

describe("public/sw.js stays in sync with the typed rules", () => {
  // Run the real worker script in a sandbox that stands in for ServiceWorkerGlobalScope.
  const listeners: Record<string, unknown> = {};
  const sandbox: Record<string, unknown> = { URL, Response, Promise, location: { origin: ORIGIN }, addEventListener: (t: string, fn: unknown) => (listeners[t] = fn) };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(__dirname, "..", "public", "sw.js"), "utf8"), sandbox);
  const sw = sandbox.__swRules as {
    classify: (r: SwRequestInfo) => SwStrategy;
    offlineFor: (p: string) => string;
    isCacheableNavigation: (p: string) => boolean;
    PRIVATE_PREFIXES: string[];
    CACHEABLE_NAVIGATION_PREFIXES: string[];
    OFFLINE_PATHS: Record<string, string>;
  };

  it("registers install, activate and fetch handlers", () => {
    expect(Object.keys(listeners).sort()).toEqual(["activate", "fetch", "install"]);
  });
  it("has identical constants", () => {
    expect(sw.PRIVATE_PREFIXES).toEqual([...PRIVATE_PREFIXES]);
    expect(sw.CACHEABLE_NAVIGATION_PREFIXES).toEqual([...CACHEABLE_NAVIGATION_PREFIXES]);
    expect(sw.OFFLINE_PATHS).toEqual({ ...OFFLINE_PATHS });
  });
  it.each(CASES)("classifies like the TS rules: %s", (_name, info, expected) => {
    expect(sw.classify(info)).toBe(expected);
  });
  it("offline and cacheable helpers agree", () => {
    for (const p of ["/", "/hi", "/hi/help", "/help/x", "/history", "/helpdesk", "/offline"]) {
      expect(sw.offlineFor(p)).toBe(offlineFor(p));
      expect(sw.isCacheableNavigation(p)).toBe(isCacheableNavigation(p));
    }
  });
});

describe("web app manifest and CSP", () => {
  const m = manifest();
  it("is installable, standalone, starts at / and uses the design-token colours", () => {
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    expect(m.name && m.short_name).toBeTruthy();
    expect(m.theme_color).toBe("#6d3ff0");
    expect(m.background_color).toBe("#f8f9fc");
  });
  it("lists 192 and 512 PNG icons plus a maskable one, all generated by /icons/[name]", () => {
    const icons = m.icons ?? [];
    expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const i of icons) {
      expect(i.type).toBe("image/png");
      expect(PWA_ICONS.some((p) => `/icons/${p.file}` === i.src)).toBe(true);
    }
  });
  it("the buyer-web CSP allows the worker and the manifest from this origin", () => {
    const csp = securityHeaders({ app: "web", reportOnly: false, env: { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv })["Content-Security-Policy"]!;
    expect(csp).toMatch(/worker-src 'self'/);
    expect(csp).toMatch(/manifest-src 'self'/);
  });
});
