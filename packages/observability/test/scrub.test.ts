import { describe, expect, it } from "vitest";
import { scrub, scrubEvent, sentryOptions } from "../src";

describe("scrub", () => {
  it("masks Indian PII and drops secrets", () => {
    const out = scrub({
      msg: "call +91 98765 43210 or 9876543210, mail a.b@x.in, GST 27AAPFU0939F1ZV, PAN ABCDE1234F",
      nested: { password: "hunter2", refreshToken: "abc" },
    });
    expect(out.msg).not.toMatch(/9876|a\.b@x\.in|27AAPFU|ABCDE1234F/);
    expect(out.nested).toEqual({ password: "[redacted]", refreshToken: "[redacted]" });
  });

  it("keeps only an opaque user id and strips request cookies/body", () => {
    const e = scrubEvent({
      user: { id: "u1", email: "x@y.com", ip_address: "1.2.3.4" },
      request: { cookies: { cnote_at: "jwt" }, data: { email: "x@y.com" }, headers: { cookie: "a", "user-agent": "UA" } },
    });
    expect(e.user).toEqual({ id: "u1" });
    expect(e.request).toEqual({ headers: { "user-agent": "UA" } });
  });
});

describe("sentryOptions", () => {
  it("is disabled without a DSN", () => {
    expect(sentryOptions("web", "nodejs", {}).enabled).toBe(false);
  });
  it("uses the public DSN in the browser only", () => {
    expect(sentryOptions("web", "browser", { SENTRY_DSN: "s" }).dsn).toBeUndefined();
    expect(sentryOptions("web", "browser", { NEXT_PUBLIC_SENTRY_DSN: "p" }).dsn).toBe("p");
  });
  it("samples 10% in production by default", () => {
    expect(sentryOptions("web", "nodejs", { NODE_ENV: "production", SENTRY_DSN: "d" }).tracesSampleRate).toBe(0.1);
  });
});

describe("URL query credentials", () => {
  it("redacts tokens, OAuth codes and signatures in URLs but keeps harmless params", async () => {
    const { scrubString } = await import("../src");
    expect(scrubString("https://app/reset-password?token=abc123&next=/account")).toBe("https://app/reset-password?token=[redacted]&next=/account");
    expect(scrubString("/api/auth/google-callback?code=4/0Ab&state=xyz&scope=email")).toBe("/api/auth/google-callback?code=[redacted]&state=[redacted]&scope=email");
    expect(scrubString("https://r2/x.png?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA")).toBe("https://r2/x.png?X-Amz-Signature=[redacted]&X-Amz-Credential=[redacted]");
    expect(scrubString("q=kraft+box&page=2")).toBe("q=kraft+box&page=2");
    expect(scrubString("access_token=eyJhbGciOi")).toBe("access_token=[redacted]");
  });

  it("scrubs the request URL and query_string of an event", async () => {
    const { scrubEvent } = await import("../src");
    const e = scrubEvent({ request: { url: "https://app/verify?otp=123456&email=a@b.in", query_string: "otp=123456&email=a@b.in" } });
    expect(JSON.stringify(e)).not.toMatch(/123456|a@b\.in/);
  });
});
