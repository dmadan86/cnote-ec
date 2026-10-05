import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertRequiredSecrets, awsSecretsManager, azureKeyVaultSecrets, dopplerSecrets, devAdapter, envSecrets, gcpSecretManager, getHumanVerifier, hcaptchaAdapter, isWeakSecret,
  loadSecretsIntoEnv, recaptchaAdapter, setHumanVerifier, turnstileAdapter, validateSecrets, verifyHuman, type SecretsApp,
} from "../src";

afterEach(() => {
  setHumanVerifier(null);
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("siteverify adapters (mocked fetch)", () => {
  const mk = (impl: (u: string, init: RequestInit) => Promise<Response>) => vi.fn(impl) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it.each([
    ["turnstile", turnstileAdapter, "https://challenges.cloudflare.com/turnstile/v0/siteverify"],
    ["hcaptcha", hcaptchaAdapter, "https://hcaptcha.com/siteverify"],
    ["recaptcha", recaptchaAdapter, "https://www.google.com/recaptcha/api/siteverify"],
  ] as const)("%s: posts a form body to the right endpoint with a timeout signal", async (name, factory, endpoint) => {
    const f = mk(async () => json({ success: true }));
    const v = factory("SEC", f);
    expect(v.name).toBe(name);
    expect(await v.verify("tok", "203.0.113.5")).toEqual({ ok: true });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(endpoint);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({ secret: "SEC", response: "tok", remoteip: "203.0.113.5" });
  });

  it("omits remoteip when there is no client IP", async () => {
    const f = mk(async () => json({ success: true }));
    await turnstileAdapter("s", f).verify("tok", null);
    await turnstileAdapter("s", f).verify("tok");
    for (const c of (f as unknown as ReturnType<typeof vi.fn>).mock.calls) expect(((c[1] as { body: URLSearchParams }).body).has("remoteip")).toBe(false);
  });

  it("never calls the provider for missing/oversized tokens", async () => {
    const f = mk(async () => json({ success: true }));
    const v = turnstileAdapter("s", f);
    for (const t of [undefined, null, "", "x".repeat(4097)]) expect(await v.verify(t)).toEqual({ ok: false, reason: "missing_token" });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(await v.verify("x".repeat(4096))).toEqual({ ok: true }); // boundary
  });

  it("rejections surface the first provider error code, or 'rejected'", async () => {
    expect(await turnstileAdapter("s", mk(async () => json({ success: false, "error-codes": ["timeout-or-duplicate", "x"] }))).verify("t")).toEqual({ ok: false, reason: "timeout-or-duplicate" });
    expect(await turnstileAdapter("s", mk(async () => json({ success: false }))).verify("t")).toEqual({ ok: false, reason: "rejected" });
    expect(await turnstileAdapter("s", mk(async () => json({ success: false, "error-codes": [] }))).verify("t")).toEqual({ ok: false, reason: "rejected" });
    expect(await turnstileAdapter("s", mk(async () => json({}))).verify("t")).toEqual({ ok: false, reason: "rejected" });
  });

  it("only a literal boolean true is a pass (truthy strings/numbers are not)", async () => {
    for (const success of ["true", "false", 1, "yes", {}, [], null]) {
      expect(await turnstileAdapter("s", mk(async () => json({ success }))).verify("t"), JSON.stringify(success)).toMatchObject({ ok: false });
    }
  });

  it("HTTP errors map to provider_http_<status> and fail closed", async () => {
    for (const status of [400, 429, 500, 503]) expect(await turnstileAdapter("s", mk(async () => json({ success: true }, status))).verify("t")).toEqual({ ok: false, reason: `provider_http_${status}` });
  });

  it("network failure, timeout abort and invalid JSON all fail closed as provider_unreachable", async () => {
    expect(await turnstileAdapter("s", mk(async () => Promise.reject(new TypeError("fetch failed")))).verify("t")).toEqual({ ok: false, reason: "provider_unreachable" });
    expect(await turnstileAdapter("s", mk(async () => Promise.reject(new DOMException("timeout", "TimeoutError")))).verify("t")).toEqual({ ok: false, reason: "provider_unreachable" });
    expect(await turnstileAdapter("s", mk(async () => new Response("<html>oops", { status: 200 }))).verify("t")).toEqual({ ok: false, reason: "provider_unreachable" });
  });

  it("token and secret are form-encoded (no parameter injection via the token)", async () => {
    const f = mk(async () => json({ success: true }));
    await turnstileAdapter("s&x=1", f).verify("a&secret=evil", "1.1.1.1&x=2");
    const body = ((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { body: URLSearchParams }).body;
    expect(body.get("secret")).toBe("s&x=1");
    expect(body.get("response")).toBe("a&secret=evil");
    expect(body.getAll("secret")).toHaveLength(1);
    expect(body.toString()).not.toContain("secret=evil");
  });

  it("uses the global fetch when none is injected", async () => {
    const g = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ success: true }));
    expect(await turnstileAdapter("s").verify("t")).toEqual({ ok: true });
    expect(g).toHaveBeenCalledTimes(1);
  });
});

describe("getHumanVerifier selection", () => {
  it("HUMAN_VERIFIER=off (any case) is the dev adapter, even in production", async () => {
    for (const v of ["off", "OFF"]) expect(getHumanVerifier({ NODE_ENV: "production", HUMAN_VERIFIER: v })).toBe(devAdapter);
    expect(await devAdapter.verify(null)).toEqual({ ok: true });
  });
  it("secret present: picks the matching provider (case-insensitive); default is turnstile", () => {
    expect(getHumanVerifier({ TURNSTILE_SECRET: "s" }).name).toBe("turnstile");
    expect(getHumanVerifier({ HUMAN_VERIFIER: "hcaptcha", HCAPTCHA_SECRET: "s" }).name).toBe("hcaptcha");
    expect(getHumanVerifier({ HUMAN_VERIFIER: "ReCaptcha", RECAPTCHA_SECRET: "s" }).name).toBe("recaptcha");
    expect(getHumanVerifier({ HUMAN_VERIFIER: "turnstile", TURNSTILE_SECRET: "s" }).name).toBe("turnstile");
    expect(getHumanVerifier({ HUMAN_VERIFIER: "unknown-vendor", TURNSTILE_SECRET: "s" }).name).toBe("turnstile");
  });
  it("uses the selected provider's own secret (not another's)", () => {
    expect(getHumanVerifier({ NODE_ENV: "production", HUMAN_VERIFIER: "hcaptcha", TURNSTILE_SECRET: "s" }).name).toBe("unconfigured");
    expect(getHumanVerifier({ NODE_ENV: "production", HUMAN_VERIFIER: "recaptcha", HCAPTCHA_SECRET: "s" }).name).toBe("unconfigured");
  });
  it("secret missing: dev adapter outside production, fail-closed in production", async () => {
    for (const env of ["development", "test", undefined]) expect(getHumanVerifier({ NODE_ENV: env }).name).toBe("dev");
    const v = getHumanVerifier({ NODE_ENV: "production" });
    expect(await v.verify("a-perfectly-valid-token")).toEqual({ ok: false, reason: "not_configured" });
  });
  it("setHumanVerifier overrides everything until reset; verifyHuman delegates with the ip", async () => {
    const verify = vi.fn(async () => ({ ok: true as const }));
    setHumanVerifier({ name: "mine", verify });
    expect(getHumanVerifier({ NODE_ENV: "production" }).name).toBe("mine");
    await verifyHuman("tok", "1.2.3.4");
    expect(verify).toHaveBeenCalledWith("tok", "1.2.3.4");
    setHumanVerifier(null);
    const prev = process.env.NODE_ENV;
    expect(getHumanVerifier({ NODE_ENV: "development" }).name).toBe("dev");
    expect(prev).toBeDefined();
  });
});

describe("isWeakSecret", () => {
  it("anything shorter than 32 chars is weak (property)", () => {
    fc.assert(fc.property(fc.string({ maxLength: 31 }), (s) => isWeakSecret(s)), { seed: 1, numRuns: 200 });
  });
  it("strong: 32+ chars, 10+ distinct characters, no placeholder words", () => {
    expect(isWeakSecret("Zq8vK3mPx7Ld0Rt5YhNc2WbGe9UfAj4S1oXi6")).toBe(false);
    expect(isWeakSecret("a".repeat(64))).toBe(true); // low entropy
    expect(isWeakSecret("abababababababababababababababab")).toBe(true);
    expect(isWeakSecret("Zq8vK3mPx7Ld0Rt5YhNc2WbGe9UfAj4S")).toBe(false); // exactly 32
    expect(isWeakSecret("Zq8vK3mPx7Ld0Rt5YhNc2WbGe9UfAj4")).toBe(true); // 31
  });
  it.each(["change-me", "changeme", "CHANGE_ME", "dev-only", "devonly", "insecure", "example", "password", "secret-key", "secretkey", "placeholder", "default", "test"])(
    "a strong-looking value containing %j is weak",
    (marker) => expect(isWeakSecret(`Zq8vK3mPx7Ld0Rt5${marker}YhNc2WbGe9UfAj4S1oXi6`)).toBe(true),
  );
});

describe("validateSecrets matrix", () => {
  const STRONG = "Zq8vK3mPx7Ld0Rt5YhNc2WbGe9UfAj4S1oXi6";
  const STRONG2 = "Hn4bT9yQe2Ws7Vc1Xr6Zk3Lm8Pd5Fg0JaUo";
  const STRONG3 = "Bv7nM2xC9zL4kJ1hG6fD3sA8pO5iU0yTrEwQ";
  const KEYS = `k1:${Buffer.alloc(32, 7).toString("base64")}`;
  const BI = Buffer.alloc(32, 9).toString("base64");
  const prod = (over: Record<string, string | undefined> = {}) => ({
    NODE_ENV: "production", DATABASE_URL: "postgres://x/db?sslmode=require", REDIS_URL: "rediss://x", JWT_SECRET_WEB: STRONG, JWT_SECRET_SELLER: STRONG2, JWT_SECRET_ADMIN: STRONG3,
    FIELD_ENCRYPTION_KEYS: KEYS, BLIND_INDEX_KEY: BI, TURNSTILE_SECRET: "t", NEXT_PUBLIC_TURNSTILE_SITE_KEY: "s", ATTACHMENT_SCANNER: "clamav", CLAMAV_HOST: "clamav.internal", ...over,
  });
  const apps: SecretsApp[] = ["web", "seller", "admin", "studio", "api", "worker"];
  const errs = (app: SecretsApp, env: Record<string, string | undefined>) => validateSecrets(app, env).errors.join("\n");

  it.each(apps)("a complete production config is clean for %s", (app) => {
    expect(validateSecrets(app, prod())).toEqual({ errors: [], warnings: [] });
  });

  it("realm secrets: dedicated preferred over master; falls back to JWT_SECRET with a warning", () => {
    const r = validateSecrets("web", prod({ JWT_SECRET_WEB: undefined, JWT_SECRET: STRONG }));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/JWT_SECRET_WEB is not set/);
  });
  it("missing realm secret: error in production, warning otherwise", () => {
    expect(errs("admin", prod({ JWT_SECRET_ADMIN: undefined }))).toMatch(/JWT_SECRET_ADMIN \(or JWT_SECRET\) is not set/);
    const dev = validateSecrets("admin", { NODE_ENV: "development" });
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.join("\n")).toMatch(/JWT_SECRET_ADMIN/);
  });
  it("weak dedicated secret names the variable; weak master names JWT_SECRET", () => {
    expect(errs("seller", prod({ JWT_SECRET_SELLER: "short" }))).toMatch(/JWT_SECRET_SELLER is weak/);
    expect(errs("web", prod({ JWT_SECRET_WEB: undefined, JWT_SECRET: "changeme-changeme-changeme-changeme" }))).toMatch(/JWT_SECRET is weak/);
  });
  it("realm isolation: no two realms may share a secret, nor equal the master", () => {
    expect(errs("web", prod({ JWT_SECRET_SELLER: STRONG }))).toMatch(/JWT_SECRET_SELLER must differ from JWT_SECRET_WEB/);
    expect(errs("admin", prod({ JWT_SECRET: STRONG3 }))).toMatch(/JWT_SECRET_ADMIN must differ from JWT_SECRET/);
    expect(errs("web", prod())).not.toMatch(/must differ/);
  });
  it("studio uses the seller realm; api/worker have no realm secret requirement", () => {
    expect(errs("studio", prod({ JWT_SECRET_SELLER: undefined, JWT_SECRET: undefined }))).toMatch(/JWT_SECRET_SELLER/);
    expect(errs("api", prod({ JWT_SECRET_WEB: undefined, JWT_SECRET_SELLER: undefined, JWT_SECRET_ADMIN: undefined }))).not.toMatch(/JWT/);
    expect(errs("worker", prod({ JWT_SECRET_WEB: undefined }))).not.toMatch(/JWT/);
  });
  it("production requires DATABASE_URL and REDIS_URL; dev does not", () => {
    expect(errs("api", prod({ DATABASE_URL: undefined }))).toMatch(/DATABASE_URL/);
    expect(errs("api", prod({ REDIS_URL: undefined }))).toMatch(/REDIS_URL/);
    expect(errs("api", { NODE_ENV: "development" })).toBe("");
  });
  it("FIELD_ENCRYPTION_KEYS: missing / bad id / wrong length / duplicate / unknown active kid", () => {
    expect(errs("api", prod({ FIELD_ENCRYPTION_KEYS: undefined }))).toMatch(/FIELD_ENCRYPTION_KEYS is not set/);
    expect(errs("api", prod({ FIELD_ENCRYPTION_KEYS: `bad id:${KEYS.split(":")[1]}` }))).toMatch(/invalid key id/);
    expect(errs("api", prod({ FIELD_ENCRYPTION_KEYS: `:${KEYS.split(":")[1]}` }))).toMatch(/invalid key id/);
    expect(errs("api", prod({ FIELD_ENCRYPTION_KEYS: `k1:${Buffer.alloc(16).toString("base64")}` }))).toMatch(/must decode to 32 bytes/);
    expect(errs("api", prod({ FIELD_ENCRYPTION_KEYS: `${KEYS},${KEYS}` }))).toMatch(/duplicate key id "k1"/);
    expect(errs("api", prod({ FIELD_ENCRYPTION_ACTIVE_KID: "nope" }))).toMatch(/ACTIVE_KID is not in/);
    expect(errs("api", prod({ FIELD_ENCRYPTION_ACTIVE_KID: "k1" }))).toBe("");
  });
  it("FIELD_KMS other than local skips the keyring checks (case-insensitive) but not the blind index", () => {
    for (const kms of ["aws", "AWS", "Azure", "gcp"]) expect(errs("api", prod({ FIELD_KMS: kms, FIELD_ENCRYPTION_KEYS: undefined }))).toBe("");
    expect(errs("api", prod({ FIELD_KMS: "LOCAL", FIELD_ENCRYPTION_KEYS: undefined }))).toMatch(/FIELD_ENCRYPTION_KEYS is not set/);
    expect(errs("api", prod({ FIELD_KMS: "aws", BLIND_INDEX_KEY: undefined }))).toMatch(/BLIND_INDEX_KEY/);
  });
  it("BLIND_INDEX_KEY: missing or under 32 bytes", () => {
    expect(errs("api", prod({ BLIND_INDEX_KEY: undefined }))).toMatch(/BLIND_INDEX_KEY is not set/);
    expect(errs("api", prod({ BLIND_INDEX_KEY: Buffer.alloc(31).toString("base64") }))).toMatch(/at least 32 bytes/);
    expect(errs("api", prod({ BLIND_INDEX_KEY: Buffer.alloc(64).toString("base64") }))).toBe("");
  });
  it("studio skips field-crypto requirements entirely", () => {
    expect(errs("studio", prod({ FIELD_ENCRYPTION_KEYS: undefined, BLIND_INDEX_KEY: undefined }))).toBe("");
  });
  it("bot protection (web/seller, production): provider-specific secret and the Turnstile site key", () => {
    for (const app of ["web", "seller"] as const) {
      expect(errs(app, prod({ TURNSTILE_SECRET: undefined }))).toMatch(/TURNSTILE_SECRET is not set/);
      expect(errs(app, prod({ NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined }))).toMatch(/SITE_KEY/);
      expect(errs(app, prod({ HUMAN_VERIFIER: "hcaptcha", HCAPTCHA_SECRET: undefined }))).toMatch(/HCAPTCHA_SECRET is not set/);
      expect(errs(app, prod({ HUMAN_VERIFIER: "recaptcha", RECAPTCHA_SECRET: undefined }))).toMatch(/RECAPTCHA_SECRET is not set/);
      expect(errs(app, prod({ HUMAN_VERIFIER: "hcaptcha", HCAPTCHA_SECRET: "h", NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined }))).toBe("");
      expect(errs(app, prod({ HUMAN_VERIFIER: "off", TURNSTILE_SECRET: undefined, NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined }))).toBe("");
    }
    for (const app of ["admin", "studio", "api", "worker"] as const) expect(errs(app, prod({ TURNSTILE_SECRET: undefined }))).toBe("");
  });
  it("HUMAN_VERIFIER is matched case-insensitively, consistently with getHumanVerifier", () => {
    expect(errs("web", prod({ HUMAN_VERIFIER: "OFF", TURNSTILE_SECRET: undefined, NEXT_PUBLIC_TURNSTILE_SITE_KEY: undefined }))).toBe("");
    expect(errs("web", prod({ HUMAN_VERIFIER: "HCaptcha", HCAPTCHA_SECRET: "h", TURNSTILE_SECRET: undefined }))).not.toMatch(/TURNSTILE_SECRET/);
    expect(errs("web", prod({ HUMAN_VERIFIER: "HCaptcha", HCAPTCHA_SECRET: undefined }))).toMatch(/HCAPTCHA_SECRET is not set/);
  });
  it("bot protection is not an error outside production", () => {
    expect(errs("web", { NODE_ENV: "development" })).toBe("");
  });
  it("CSP_REPORT_ONLY in production is an error unless CSP_REPORT_ONLY_ACK=1 (then a warning)", () => {
    expect(errs("api", prod({ CSP_REPORT_ONLY: "1" }))).toMatch(/CSP_REPORT_ONLY_ACK/);
    const acked = validateSecrets("api", prod({ CSP_REPORT_ONLY: "1", CSP_REPORT_ONLY_ACK: "1" }));
    expect(acked.errors).toEqual([]);
    expect(acked.warnings.join()).toMatch(/not being enforced/);
    expect(validateSecrets("api", { ...prod(), NODE_ENV: "development", CSP_REPORT_ONLY: "1" }).warnings.join()).not.toMatch(/not being enforced/);
  });
  it("production rejects OTP_DEV_ECHO (only the e2e opt-out downgrades it to a warning)", () => {
    expect(errs("api", prod({ OTP_DEV_ECHO: "true" }))).toMatch(/OTP_DEV_ECHO/);
    expect(errs("api", prod({ OTP_DEV_ECHO: "false" }))).toBe("");
    const e2e = validateSecrets("api", prod({ OTP_DEV_ECHO: "true", ALLOW_OTP_ECHO_IN_PRODUCTION: "1" }));
    expect(e2e.errors).toEqual([]);
    expect(e2e.warnings.join()).toMatch(/OTP_DEV_ECHO/);
    expect(errs("api", { ...prod({ OTP_DEV_ECHO: "true" }), NODE_ENV: "development" })).toBe("");
  });
  it("production refuses uploads without a malware scanner unless uploads are off or the risk is waived", () => {
    for (const app of ["web", "seller"] as const) {
      expect(errs(app, prod({ ATTACHMENT_SCANNER: undefined, CLAMAV_HOST: undefined })), app).toMatch(/malware scanner/);
      expect(errs(app, prod({ ATTACHMENT_SCANNER: "mock" })), app).toMatch(/malware scanner/);
      expect(errs(app, prod({ ATTACHMENT_SCANNER: "off" })), app).toMatch(/ATTACHMENT_SCAN_WAIVER/);
    }
    expect(errs("web", prod({ CLAMAV_HOST: undefined }))).toMatch(/CLAMAV_HOST is not set/);
    expect(errs("web", prod({ CLAMAV_HOST: "  " }))).toMatch(/CLAMAV_HOST is not set/);
    // uploads off: no scanner needed
    for (const off of ["false", "0", "no", "off"]) expect(errs("web", prod({ ATTACHMENT_SCANNER: undefined, CLAMAV_HOST: undefined, RFQ_ATTACHMENTS_ENABLED: off }))).toBe("");
    // explicit waiver downgrades to a loud warning
    const waived = validateSecrets("web", prod({ ATTACHMENT_SCANNER: "mock", ATTACHMENT_SCAN_WAIVER: "1" }));
    expect(waived.errors).toEqual([]);
    expect(waived.warnings.join()).toMatch(/NOT virus-scanned/);
    // apps that take no uploads are not affected; non-production never errors
    for (const app of ["admin", "studio", "worker", "api"] as const) expect(errs(app, prod({ ATTACHMENT_SCANNER: undefined, CLAMAV_HOST: undefined }))).toBe("");
    expect(errs("web", { ...prod({ ATTACHMENT_SCANNER: undefined, CLAMAV_HOST: undefined }), NODE_ENV: "development" })).toBe("");
  });
  it("production requires the webhook secret of every ENABLED provider", () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ PAYMENTS_PROVIDER: "razorpay" }, /RAZORPAY_WEBHOOK_SECRET/],
      [{ PAYMENTS_PROVIDER: "cashfree" }, /CASHFREE_WEBHOOK_SECRET/],
      [{ ESCROW_ENABLED: "true" }, /ESCROW_WEBHOOK_SECRET/],
      [{ CREDIT_ENABLED: "1" }, /CREDIT_WEBHOOK_SECRET/],
      [{ KYC_PROVIDER: "signzy" }, /KYC_WEBHOOK_SECRET/],
      [{ WHATSAPP_ACCESS_TOKEN: "tok" }, /WHATSAPP_APP_SECRET/],
      [{ WHATSAPP_ACCESS_TOKEN: "tok" }, /WHATSAPP_VERIFY_TOKEN/],
    ];
    for (const [env, re] of cases) expect(errs("api", prod(env))).toMatch(re);
    // satisfied, or not enabled: no error
    expect(errs("api", prod({ PAYMENTS_PROVIDER: "razorpay", RAZORPAY_WEBHOOK_SECRET: "s" }))).toBe("");
    expect(errs("api", prod({ ESCROW_ENABLED: "false", CREDIT_ENABLED: "false", KYC_PROVIDER: "mock" }))).toBe("");
  });
  it("production rejects a weak REVALIDATE_SECRET and requires DOMAIN_CHECK_SECRET with custom domains", () => {
    expect(errs("web", prod({ REVALIDATE_SECRET: "short" }))).toMatch(/REVALIDATE_SECRET/);
    expect(errs("web", prod({ REVALIDATE_SECRET: "x".repeat(32) }))).toBe("");
    expect(errs("web", prod({ EDGE_PROVIDER: "cloudflare" }))).toMatch(/DOMAIN_CHECK_SECRET/);
    expect(errs("web", prod({ EDGE_PROVIDER: "cloudflare", DOMAIN_CHECK_SECRET: "d" }))).toBe("");
  });
  it("production requires TLS to Postgres and Redis unless loopback or explicitly waived", () => {
    expect(errs("api", prod({ DATABASE_URL: "postgres://u:p@db.internal/cnote" }))).toMatch(/DATABASE_URL has no TLS/);
    expect(errs("api", prod({ LIVE_DATABASE_URL: "postgres://u:p@db.internal/live?sslmode=prefer" }))).toMatch(/LIVE_DATABASE_URL has no TLS/);
    expect(errs("api", prod({ DATABASE_URL: "postgres://u:p@db.internal/cnote?sslmode=verify-full" }))).toBe("");
    expect(errs("api", prod({ DATABASE_URL: "postgres://u:p@localhost/cnote" }))).toBe("");
    expect(errs("api", prod({ DATABASE_URL: "postgres://u:p@db.internal/cnote", DB_TLS_OPTIONAL: "1" }))).toBe("");
    expect(errs("api", prod({ REDIS_URL: "redis://cache.internal:6379" }))).toMatch(/rediss/);
    expect(errs("api", prod({ REDIS_URL: "redis://cache.internal:6379", REDIS_TLS_OPTIONAL: "1" }))).toBe("");
    expect(errs("api", prod({ REDIS_URL: "redis://127.0.0.1:6379" }))).toBe("");
  });
  it("outside production every secret problem is only a warning", () => {
    const r = validateSecrets("web", { NODE_ENV: "development", JWT_SECRET_WEB: "weak", BLIND_INDEX_KEY: "x" });
    expect(r.errors).toEqual([]);
    expect(r.warnings.length).toBeGreaterThan(2);
  });
  it("defaults to process.env", () => {
    expect(validateSecrets("api")).toEqual(expect.objectContaining({ errors: expect.any(Array), warnings: expect.any(Array) }));
  });
});

describe("assertRequiredSecrets", () => {
  it("production: throws listing every problem, and does not leak secret values", () => {
    const secret = "TopSecretValue-XYZ-do-not-log-1234567890";
    let msg = "";
    try {
      assertRequiredSecrets("web", { NODE_ENV: "production", JWT_SECRET: secret + "changeme" });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/Refusing to start web/);
    expect(msg.split("\n - ").length).toBeGreaterThan(3);
    expect(msg).not.toContain(secret);
  });
  it("non-production: warns per warning and returns the report; production with a good config returns it too", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const r = assertRequiredSecrets("api", { NODE_ENV: "development" });
    expect(warn).toHaveBeenCalledTimes(r.warnings.length);
    expect(warn.mock.calls.every(([m]) => String(m).startsWith("[security] "))).toBe(true);
    expect(assertRequiredSecrets("api", { NODE_ENV: "production", DATABASE_URL: "d", REDIS_URL: "r", FIELD_ENCRYPTION_KEYS: `k:${Buffer.alloc(32, 3).toString("base64")}`, BLIND_INDEX_KEY: Buffer.alloc(32, 4).toString("base64") }).errors).toEqual([]);
  });
});

describe("secrets providers", () => {
  const KEYS = ["CNOTE_T_A", "CNOTE_T_B", "CNOTE_T_C"];
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));
  it("envSecrets reads process.env", async () => {
    process.env.CNOTE_T_A = "v";
    expect(envSecrets.name).toBe("env");
    expect(await envSecrets.get("CNOTE_T_A")).toBe("v");
    expect(await envSecrets.get("CNOTE_T_MISSING")).toBeUndefined();
  });
  it("loadSecretsIntoEnv fills only unset keys, skips empty values, and asks the provider only for missing keys", async () => {
    process.env.CNOTE_T_A = "already";
    const get = vi.fn(async (k: string) => ({ CNOTE_T_A: "from-provider", CNOTE_T_B: "b", CNOTE_T_C: "" })[k]);
    await loadSecretsIntoEnv({ name: "p", get }, KEYS);
    expect(process.env.CNOTE_T_A).toBe("already");
    expect(process.env.CNOTE_T_B).toBe("b");
    expect(process.env.CNOTE_T_C).toBeUndefined();
    expect(get.mock.calls.map((c) => c[0])).toEqual(["CNOTE_T_B", "CNOTE_T_C"]);
  });
  it("a provider failure propagates (boot must not continue half-configured)", async () => {
    await expect(loadSecretsIntoEnv({ name: "p", get: async () => Promise.reject(new Error("vault down")) }, ["CNOTE_T_A"])).rejects.toThrow("vault down");
  });
  it.each([[awsSecretsManager, "aws-secrets-manager"], [azureKeyVaultSecrets, "azure-key-vault"], [gcpSecretManager, "gcp-secret-manager"], [dopplerSecrets, "doppler"]] as const)(
    "%s stub fails loudly with an actionable message",
    async (factory, name) => {
      const p = factory();
      expect(p.name).toBe(name);
      await expect(p.get("X")).rejects.toThrow(/not implemented/);
    },
  );
});
