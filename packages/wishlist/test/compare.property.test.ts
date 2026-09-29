import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addToCompare, COMPARE_MAX, parseCompareIds, serializeCompareIds } from "../src";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuid = fc.uuid();
const token = fc.oneof(uuid, uuid.map((u) => u.toUpperCase()), uuid.map((u) => ` ${u} `), fc.string({ maxLength: 12 }).filter((s) => !s.includes(",")), fc.constant(""));
const raw = fc.array(token, { maxLength: 12 }).map((a) => a.join(","));

describe("parseCompareIds properties", () => {
  it("output: only lowercase uuids, unique, at most 4", () => {
    fc.assert(fc.property(raw, (r) => {
      const out = parseCompareIds(r);
      expect(out.length).toBeLessThanOrEqual(COMPARE_MAX);
      expect(new Set(out).size).toBe(out.length);
      for (const id of out) expect(id).toMatch(UUID);
    }));
  });
  it("is idempotent through serialize, and preserves first-seen order of valid ids", () => {
    fc.assert(fc.property(raw, (r) => {
      const out = parseCompareIds(r);
      expect(parseCompareIds(serializeCompareIds(out))).toEqual(out);
      expect(parseCompareIds(out.join(","))).toEqual(out);
      const validInOrder = [...new Set(r.split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)))];
      expect(out).toEqual(validInOrder.slice(0, COMPARE_MAX));
    }));
  });
  it("url-encoded form parses identically", () => {
    fc.assert(fc.property(raw, (r) => { expect(parseCompareIds(encodeURIComponent(r))).toEqual(parseCompareIds(r)); }));
  });
  it("never throws on arbitrary text", () => {
    fc.assert(fc.property(fc.string(), (s) => { parseCompareIds(s); }));
  });
});

describe("addToCompare properties", () => {
  it("never exceeds the cap, never drops existing ids, blocks other categories, adds at most one id", () => {
    fc.assert(fc.property(fc.array(uuid, { maxLength: 6 }), uuid, fc.constantFrom("c1", "c2"), fc.constantFrom("c1", "c2", null), (ids, id, cat, tray) => {
      const current = parseCompareIds(ids.join(","));
      const r = addToCompare(ids, id, cat, tray);
      expect(r.ids.length).toBeLessThanOrEqual(COMPARE_MAX);
      expect(r.ids.slice(0, current.length)).toEqual(current);
      if (r.status === "added") {
        expect(r.ids).toEqual([...current, id.toLowerCase()]);
        expect(current.length).toBeLessThan(COMPARE_MAX);
        if (current.length > 0 && tray !== null) expect(tray).toBe(cat);
      } else {
        expect(r.ids).toEqual(current);
      }
      if (r.status === "already") expect(current).toContain(id.toLowerCase());
      if (r.status === "category_mismatch") expect(tray).not.toBe(cat);
      if (r.status === "full") expect(current.length).toBe(COMPARE_MAX);
    }));
  });
  it("adding uppercase form of a present id is 'already'", () => {
    fc.assert(fc.property(uuid, (u) => { expect(addToCompare([u], u.toUpperCase(), "c", "c").status).toBe("already"); }));
  });
});
