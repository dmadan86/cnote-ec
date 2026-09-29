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
