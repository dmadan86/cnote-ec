import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scrubEvent, sentryOptions } from "../src";

describe("sentryOptions", () => {
  it("wires scrubbing into both hooks and never sends default PII", () => {
    const o = sentryOptions("worker", "nodejs", { SENTRY_DSN: "d" });
    expect(o.beforeSend).toBe(scrubEvent);
    expect(o.beforeSendTransaction).toBe(scrubEvent);
    expect(o.sendDefaultPii).toBe(false);
    expect(o.initialScope).toEqual({ tags: { app: "worker", runtime: "nodejs" } });
    expect(o.enabled).toBe(true);
  });
  it("server DSN precedence: SENTRY_DSN over NEXT_PUBLIC_SENTRY_DSN; empty string counts as unset", () => {
    expect(sentryOptions("web", "nodejs", { SENTRY_DSN: "s", NEXT_PUBLIC_SENTRY_DSN: "p" }).dsn).toBe("s");
    expect(sentryOptions("web", "edge", { NEXT_PUBLIC_SENTRY_DSN: "p" }).dsn).toBe("p");
    const o = sentryOptions("web", "nodejs", { SENTRY_DSN: "" });
    expect(o.dsn).toBeUndefined();
    expect(o.enabled).toBe(false);
  });
  it("environment precedence and default", () => {
    expect(sentryOptions("web", "nodejs", { SENTRY_ENVIRONMENT: "a", NEXT_PUBLIC_SENTRY_ENVIRONMENT: "b", NODE_ENV: "c" }).environment).toBe("a");
    expect(sentryOptions("web", "nodejs", { NEXT_PUBLIC_SENTRY_ENVIRONMENT: "b", NODE_ENV: "c" }).environment).toBe("b");
    expect(sentryOptions("web", "nodejs", { NODE_ENV: "c" }).environment).toBe("c");
    expect(sentryOptions("web", "nodejs", {}).environment).toBe("development");
  });
  it("release precedence", () => {
    expect(sentryOptions("web", "nodejs", { SENTRY_RELEASE: "r1", NEXT_PUBLIC_SENTRY_RELEASE: "r2" }).release).toBe("r1");
    expect(sentryOptions("web", "nodejs", { NEXT_PUBLIC_SENTRY_RELEASE: "r2" }).release).toBe("r2");
    expect(sentryOptions("web", "nodejs", {}).release).toBeUndefined();
  });
  it("trace sample rate: explicit valid wins; invalid/out-of-range falls back by environment", () => {
    const rate = (v: string | undefined, env = "production") => sentryOptions("web", "nodejs", { NODE_ENV: env, SENTRY_TRACES_SAMPLE_RATE: v }).tracesSampleRate;
    expect(rate("0.5")).toBe(0.5);
    expect(rate("0")).toBe(0);
    expect(rate("1")).toBe(1);
    expect(rate("1.01")).toBe(0.1);
    expect(rate("-0.1")).toBe(0.1);
    expect(rate("abc")).toBe(0.1);
    expect(rate("")).toBe(0.1);
    expect(rate(undefined)).toBe(0.1);
    expect(rate("Infinity")).toBe(0.1);
    expect(rate(undefined, "development")).toBe(1);
    expect(
      sentryOptions("web", "browser", { NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: "0.25", NEXT_PUBLIC_SENTRY_DSN: "p" }).tracesSampleRate,
    ).toBe(0.25);
  });
  it("tracesSampleRate is always within [0, 1] for any string", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const r = sentryOptions("web", "nodejs", { SENTRY_TRACES_SAMPLE_RATE: s }).tracesSampleRate;
        return r >= 0 && r <= 1;
      }),
      { seed: 3, numRuns: 300 },
    );
  });
  it("defaults process.env when no env is given", () => {
    const prev = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "from-process";
    expect(sentryOptions("api", "nodejs").dsn).toBe("from-process");
    if (prev === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = prev;
  });
});
