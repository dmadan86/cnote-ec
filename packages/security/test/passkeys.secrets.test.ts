import { describe, expect, it } from "vitest";
import { validateSecrets, type SecretsApp } from "../src";

// Production start-up validation of the WebAuthn relying-party config (ADR-029/042, docs/design/admin-passkeys.md).
const KEYS = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
const BI = Buffer.alloc(32, 9).toString("base64");
const prod = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: "production", DATABASE_URL: "postgres://x/db?sslmode=require", REDIS_URL: "rediss://x",
  JWT_SECRET_WEB: "Zq8vK3mPx7Ld0Rt5YhNc2WbGe9UfAj4S1oXi6", JWT_SECRET_SELLER: "Hn4bT9yQe2Ws7Vc1Xr6Zk3Lm8Pd5Fg0JaUo", JWT_SECRET_ADMIN: "Bv7nM2xC9zL4kJ1hG6fD3sA8pO5iU0yTrEwQ",
  FIELD_ENCRYPTION_KEYS: KEYS, BLIND_INDEX_KEY: BI, TURNSTILE_SECRET: "t", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "s", ...over,
});
const errs = (app: SecretsApp, env: Record<string, string | undefined>) => validateSecrets(app, env).errors.join("\n");
const GOOD = { ADMIN_PASSKEYS_ENABLED: "1", ADMIN_WEBAUTHN_RP_ID: "example.com", ADMIN_WEBAUTHN_ORIGIN: "https://admin.example.com" };

describe("validateSecrets: passkeys", () => {
  it("passkeys off: nothing is required", () => {
    expect(validateSecrets("admin", prod())).toEqual({ errors: [], warnings: [] });
  });
  it("a complete config is clean (RP ID may equal the host or be a parent domain)", () => {
    expect(validateSecrets("admin", prod(GOOD)).errors).toEqual([]);
    expect(validateSecrets("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_RP_ID: "admin.example.com" })).errors).toEqual([]);
  });
  it("REQUIRE_PASSKEY alone turns validation on", () => {
    const e = errs("admin", prod({ ADMIN_REQUIRE_PASSKEY: "1" }));
    expect(e).toContain("ADMIN_WEBAUTHN_RP_ID is not set");
    expect(e).toContain("ADMIN_WEBAUTHN_ORIGIN is not set");
  });
  it("rejects http, paths, localhost and mismatched RP IDs", () => {
    expect(errs("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_ORIGIN: "http://admin.example.com" }))).toContain("bare https origin");
    expect(errs("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_ORIGIN: "https://admin.example.com/login" }))).toContain("bare https origin");
    expect(errs("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_ORIGIN: "not a url" }))).toContain("bare https origin");
    expect(errs("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_ORIGIN: "https://localhost", ADMIN_WEBAUTHN_RP_ID: "localhost" }))).toContain("must not be localhost");
    expect(errs("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_RP_ID: "other.com" }))).toContain("must equal or be a parent domain");
    expect(errs("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_RP_ID: "ample.com" }))).toContain("must equal or be a parent domain");
  });
  it("rejects IPs, ports and URLs as the RP ID", () => {
    for (const rp of ["10.0.0.1", "example.com:443", "https://example.com"]) expect(errs("admin", prod({ ...GOOD, ADMIN_WEBAUTHN_RP_ID: rp }))).toContain("must be a domain name");
  });
  it("only the realm's own app is checked; dev is never blocked", () => {
    expect(errs("web", prod({ ADMIN_PASSKEYS_ENABLED: "1" }))).not.toContain("WEBAUTHN");
    expect(errs("seller", prod({ SELLER_PASSKEYS_ENABLED: "1" }))).toContain("SELLER_WEBAUTHN_RP_ID is not set");
    expect(validateSecrets("admin", { ...prod({ ADMIN_PASSKEYS_ENABLED: "1" }), NODE_ENV: "development" }).errors).toEqual([]);
  });
});
