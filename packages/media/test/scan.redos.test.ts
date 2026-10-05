import { describe, expect, it } from "vitest";
import { parseClamdReply } from "../src/scan";

describe("parseClamdReply", () => {
  it("is fast on pathological NUL / space runs and still parses", () => {
    const t = Date.now();
    expect(() => parseClamdReply("x" + "\0a".repeat(30_000))).toThrow();
    expect(() => parseClamdReply("stream:" + " ".repeat(30_000) + "x")).toThrow();
    expect(Date.now() - t).toBeLessThan(1000);
    expect(parseClamdReply("stream: Eicar-Test FOUND\0")).toEqual({ status: "infected", signature: "Eicar-Test" });
    expect(parseClamdReply("stream: OK\0\0")).toEqual({ status: "clean" });
    expect(() => parseClamdReply("stream: FOUND")).toThrow();
  });
});
