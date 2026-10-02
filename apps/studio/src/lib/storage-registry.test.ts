import path from "node:path";
import { describe, expect, it } from "vitest";
import { cookieNames } from "@cnote/identity";
import { optionalEntries, stripCookiePrefix } from "@cnote/consent";
import { auditNecessaryOnlyApp, read } from "@cnote/consent/testing";
import { STUDIO_STORAGE_REGISTRY } from "./storage-registry";

const SRC = path.join(__dirname, "..");

describe("studio app storage: strictly necessary only, so no cookie banner", () => {
  it("registers only strictly necessary keys, including the seller-realm auth cookies next-kit writes", () => {
    expect(optionalEntries(STUDIO_STORAGE_REGISTRY)).toEqual([]);
    const names = STUDIO_STORAGE_REGISTRY.map((e) => e.name);
    const { access, refresh } = cookieNames("seller", true);
    for (const k of [stripCookiePrefix(access), stripCookiePrefix(refresh), "cnote_seller_oauth", "cnote_seller_mfa"]) expect(names, k).toContain(k);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the source writes no cookie or web storage, loads no third-party script and renders no third-party iframe (a failure here means: add a banner, gate the write, bump the policy)", () => {
    expect(auditNecessaryOnlyApp({ srcDir: SRC, registry: STUDIO_STORAGE_REGISTRY, keyPrefix: /cnote_seller_|seller_/, skip: ["lib/storage-registry.ts"] })).toEqual([]);
  });

  it("Sentry sends no PII and records no sessions", () => {
    const client = read(path.join(SRC, "instrumentation-client.ts"));
    expect(client).toContain('sentryOptions("studio", "browser")');
    expect(client).not.toMatch(/replayIntegration|replaysSessionSampleRate|browserTracingIntegration/);
  });
});
