import { DomainError, HTTP_STATUS, type ErrorCode } from "@cnote/core";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z, ZodError } from "zod";
import { errorResponse, runAction } from "../src/action-result";

afterEach(() => vi.restoreAllMocks());

describe("runAction", () => {
  it("wraps success", async () => expect(await runAction(async () => 5)).toEqual({ ok: true, data: 5 }));
  it("maps DomainError to its message", async () => {
    expect(await runAction(async () => { throw new DomainError("forbidden", "nope"); })).toEqual({ ok: false, error: "nope" });
  });
  it("maps ZodError to first message per dotted path", async () => {
    const schema = z.object({ email: z.string().email("bad email"), nested: z.object({ n: z.number("need n") }) });
    const parsed = schema.safeParse({ email: "x", nested: { n: "a" } });
    const err = (parsed as { error: ZodError }).error;
    const r = await runAction(async () => { throw err; });
    expect(r).toMatchObject({ ok: false, error: "Please fix the highlighted fields.", fieldErrors: { email: "bad email", "nested.n": "need n" } });
  });
  it("keeps the first issue when a path has several", async () => {
    const err = new ZodError([
      { code: "custom", path: ["a"], message: "first" },
      { code: "custom", path: ["a"], message: "second" },
    ]);
    const r = await runAction(async () => { throw err; });
    expect(r).toMatchObject({ fieldErrors: { a: "first" } });
  });
  it("rethrows unknown errors (never leaks them as results)", async () => {
    await expect(runAction(async () => { throw new TypeError("boom"); })).rejects.toThrow("boom");
  });
});

describe("errorResponse", () => {
  it("property: every DomainError code maps to HTTP_STATUS with code in body", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...(Object.keys(HTTP_STATUS) as ErrorCode[])), fc.string(), async (code, msg) => {
        const res = errorResponse(new DomainError(code, msg));
        expect(res.status).toBe(HTTP_STATUS[code]);
        expect(await res.json()).toEqual({ error: msg, code });
      }),
    );
  });
  it("422 with issues for ZodError", async () => {
    const res = errorResponse(new ZodError([{ code: "custom", path: ["x"], message: "m" }]));
    expect(res.status).toBe(422);
    expect((await res.json()).issues).toHaveLength(1);
  });
  it("500 generic and logs for unknown, hiding details", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = errorResponse(new Error("secret db password"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    expect(spy).toHaveBeenCalled();
  });
});
