import { describe, expect, it } from "vitest";
import { firstParty } from "../src";
import { buildSnapshot, hashSnapshot, noticeOf, registryHashFor, stableStringify } from "../src/policy";

const registry = [firstParty("a_consent", "necessary", "cookie", "consent", { unit: "months", n: 12 })];

describe("policy snapshots", () => {
  it("builds the snapshot from the registry and the notice keys of each locale (a missing string is null, never undefined)", () => {
    const snap = buildSnapshot({
      version: 4,
      updated: "2026-10-02",
      registry,
      noticeKeys: ["banner", "missing"],
      locales: ["en", "hi"],
      messages: { en: { banner: "Hello", extra: "ignored" }, hi: { banner: "नमस्ते" } },
    });
    expect(snap).toEqual({ version: 4, updated: "2026-10-02", registry, notice: { en: { banner: "Hello", missing: null }, hi: { banner: "नमस्ते", missing: null } } });
    expect(noticeOf({ a: { nested: true } }, ["a"])).toEqual({ a: { nested: true } });
  });

  it("hashes canonical JSON: key order and formatting do not matter, content does", () => {
    expect(stableStringify({ b: [1, { d: 2, c: 1 }], a: undefined })).toBe('{"b":[1,{"c":1,"d":2}]}');
    expect(stableStringify(undefined)).toBe("null");
    expect(hashSnapshot({ a: 1, b: { c: 2, d: 3 } })).toBe(hashSnapshot({ b: { d: 3, c: 2 }, a: 1 }));
    expect(hashSnapshot({ a: 1 })).not.toBe(hashSnapshot({ a: 2 }));
    expect(hashSnapshot({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  it("looks a version up in the committed snapshots; an unknown version has no hash", () => {
    const snaps = { 1: { version: 1, registry: [] } };
    expect(registryHashFor(snaps, 1)).toBe(hashSnapshot(snaps[1]));
    expect(registryHashFor(snaps, 2)).toBeNull();
  });
});
