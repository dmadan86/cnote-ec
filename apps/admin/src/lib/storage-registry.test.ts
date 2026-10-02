import path from "node:path";
import { describe, expect, it } from "vitest";
import { cookieNames } from "@cnote/identity";
import { optionalEntries, stripCookiePrefix } from "@cnote/consent";
import { auditNecessaryOnlyApp, findIframes, read, sourceFiles } from "@cnote/consent/testing";
import { ADMIN_STORAGE_REGISTRY } from "./storage-registry";

const SRC = path.join(__dirname, "..");

describe("admin app storage: strictly necessary only, so no cookie banner", () => {
  it("registers only strictly necessary keys, including the auth cookies next-kit writes for the admin realm", () => {
    expect(optionalEntries(ADMIN_STORAGE_REGISTRY)).toEqual([]);
    const names = ADMIN_STORAGE_REGISTRY.map((e) => e.name);
    const { access, refresh } = cookieNames("admin", true);
    for (const k of [stripCookiePrefix(access), stripCookiePrefix(refresh), "cnote_admin_oauth", "cnote_admin_mfa"]) expect(names, k).toContain(k);
    expect(new Set(names).size).toBe(names.length);
  });

  it("the source writes no cookie or web storage, loads no third-party script and renders no third-party iframe (a failure here means: add a banner, gate the write, bump the policy)", () => {
    // The registry file itself names the storage kinds as data; the template preview iframe has no src (sandboxed srcDoc);
    // proxy.ts only forwards the auth cookies the auth proxy rotated (the realm cookies above) onto the MFA redirect.
    expect(auditNecessaryOnlyApp({ srcDir: SRC, registry: ADMIN_STORAGE_REGISTRY, keyPrefix: /cnote_admin_/, cookieWriters: ["proxy.ts"], skip: ["lib/storage-registry.ts"] })).toEqual([]);
  });

  it("the one iframe (template preview) is sandboxed srcDoc, never a remote page", () => {
    const frames = sourceFiles(SRC).flatMap((f) => findIframes(read(f)).map((i) => ({ f: path.relative(SRC, f), src: i.src })));
    expect(frames).toEqual([{ f: path.join("features", "templates", "shared.tsx"), src: null }]);
    expect(read(path.join(SRC, "features/templates/shared.tsx"))).toMatch(/sandbox=""/);
  });

  it("Sentry sends no PII and records no sessions", () => {
    const client = read(path.join(SRC, "instrumentation-client.ts"));
    expect(client).toContain('sentryOptions("admin", "browser")');
    expect(client).not.toMatch(/replayIntegration|replaysSessionSampleRate|browserTracingIntegration/);
  });
});
