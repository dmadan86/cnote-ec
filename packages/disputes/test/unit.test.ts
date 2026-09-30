import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVE_STATUSES, APPEAL_WINDOW_DAYS, SLA_DAYS, TRANSITIONS, canTransition, deadlines, disputeConfig, disputesEnabled, faultFor, median, routeBrief, validateSplit,
} from "../src";
import { assertTransition, isActive } from "../src/state";
import { checkUpload, evidenceKey } from "../src/files";
import { JPEG, PDF, voice } from "./helpers";

const cfg = (over: Partial<ReturnType<typeof disputeConfig>> = {}) => ({ ...disputeConfig(), ...over });
const brief = (over: Partial<Parameters<typeof routeBrief>[0]> = {}) => ({
  type: "damaged" as const, claimedPaise: 200_000, recommendation: { outcome: "buyer_favour" as const, refundPaise: 200_000 }, confidence: 0.9, needsReview: false, ...over,
});

describe("config", () => {
  afterEach(() => { for (const k of ["DISPUTES_ENABLED", "DISPUTES_AUTO_MAX_PAISE", "DISPUTES_AUTO_MIN_CONFIDENCE", "DISPUTES_AUTO_TYPES", "DISPUTES_RESPONSE_HOURS", "DISPUTES_ESCALATION_HOURS"]) delete process.env[k]; });
  it("is disabled by default and reads the flag per call", () => {
    expect(disputesEnabled()).toBe(false);
    process.env.DISPUTES_ENABLED = "true";
    expect(disputesEnabled()).toBe(true);
    process.env.DISPUTES_ENABLED = "0";
    expect(disputesEnabled()).toBe(false);
  });
  it("defaults to Rs 5,000 / 0.85 / 72h / 48h and a conservative type allowlist", () => {
    expect(disputeConfig()).toEqual({ autoMaxPaise: 500_000, autoMinConfidence: 0.85, autoTypes: ["quantity_short", "damaged", "wrong_item"], responseHours: 72, escalationHours: 48 });
  });
  it("accepts overrides, ignores garbage and unknown types", () => {
    process.env.DISPUTES_AUTO_MAX_PAISE = "100000";
    process.env.DISPUTES_AUTO_MIN_CONFIDENCE = "2";
    process.env.DISPUTES_AUTO_TYPES = "damaged, bogus ,non_delivery";
    process.env.DISPUTES_RESPONSE_HOURS = "-4";
    process.env.DISPUTES_ESCALATION_HOURS = "abc";
    expect(disputeConfig()).toEqual({ autoMaxPaise: 100_000, autoMinConfidence: 1, autoTypes: ["damaged", "non_delivery"], responseHours: 72, escalationHours: 48 });
    process.env.DISPUTES_RESPONSE_HOURS = "0";
    expect(disputeConfig().responseHours).toBe(0);
  });
});

describe("state machine", () => {
  it("follows open -> evidence -> brief_ready -> (auto_resolved | awaiting_adjudication) -> resolved | withdrawn", () => {
    expect(canTransition("open", "evidence")).toBe(true);
    expect(canTransition("evidence", "brief_ready")).toBe(true);
    expect(canTransition("brief_ready", "auto_resolved")).toBe(true);
    expect(canTransition("brief_ready", "awaiting_adjudication")).toBe(true);
    expect(canTransition("auto_resolved", "awaiting_adjudication")).toBe(true); // escalation
    expect(canTransition("auto_resolved", "resolved")).toBe(true);
    expect(canTransition("awaiting_adjudication", "resolved")).toBe(true);
    expect(canTransition("open", "auto_resolved")).toBe(false);
    expect(canTransition("resolved", "open")).toBe(false);
    expect(TRANSITIONS.resolved).toEqual([]);
    expect(TRANSITIONS.withdrawn).toEqual([]);
  });
  it("assertTransition throws conflict and isActive matches the active set", () => {
    expect(() => assertTransition("resolved", "withdrawn")).toThrow(/cannot become/);
    expect(() => assertTransition("open", "evidence")).not.toThrow();
    for (const s of ACTIVE_STATUSES) expect(isActive(s)).toBe(true);
    expect(isActive("resolved")).toBe(false);
    expect(isActive("withdrawn")).toBe(false);
  });
  it("sets the 7 day SLA and the response window", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const d = deadlines(now, { responseHours: 72 });
    expect(d.dueAt.getTime() - now.getTime()).toBe(SLA_DAYS * 86_400_000);
    expect(d.responseDueAt.getTime() - now.getTime()).toBe(72 * 3_600_000);
    expect(APPEAL_WINDOW_DAYS).toBe(7);
  });
});

describe("auto-resolve routing (ADR-013)", () => {
  it("auto-resolves only clear, low-value, high-confidence, allow-listed cases", () => {
    expect(routeBrief(brief(), cfg()).autoResolvable).toBe(true);
    expect(routeBrief(brief({ confidence: 0.85 }), cfg()).autoResolvable).toBe(true);
  });
  it("routes to a human on every disqualifier and says why", () => {
    expect(routeBrief(brief({ type: "non_delivery" }), cfg())).toMatchObject({ autoResolvable: false, reason: expect.stringContaining("allowlist") });
    expect(routeBrief(brief({ needsReview: true }), cfg())).toMatchObject({ autoResolvable: false, reason: expect.stringContaining("human review") });
    expect(routeBrief(brief({ confidence: 0.84 }), cfg())).toMatchObject({ autoResolvable: false, reason: expect.stringContaining("confidence") });
    expect(routeBrief(brief({ recommendation: { outcome: "split", refundPaise: 100_000 } }), cfg())).toMatchObject({ autoResolvable: false, reason: expect.stringContaining("clearly") });
    expect(routeBrief(brief({ claimedPaise: 500_001, recommendation: { outcome: "buyer_favour", refundPaise: 1 } }), cfg()).autoResolvable).toBe(false);
    expect(routeBrief(brief({ claimedPaise: null, recommendation: { outcome: "buyer_favour", refundPaise: 600_000 } }), cfg()).autoResolvable).toBe(false);
    expect(routeBrief(brief({ claimedPaise: 500_000 }), cfg()).autoResolvable).toBe(true); // ceiling is inclusive
  });
  it("respects configuration", () => {
    expect(routeBrief(brief({ type: "non_delivery" }), cfg({ autoTypes: ["non_delivery"] })).autoResolvable).toBe(true);
    expect(routeBrief(brief(), cfg({ autoMaxPaise: 100 })).autoResolvable).toBe(false);
    expect(routeBrief(brief({ confidence: 0.7 }), cfg({ autoMinConfidence: 0.6 })).autoResolvable).toBe(true);
  });
});

describe("outcome arithmetic", () => {
  it("names the losing side as at fault and nobody for a split", () => {
    expect(faultFor("buyer_favour", "B", "S")).toBe("S");
    expect(faultFor("seller_favour", "B", "S")).toBe("B");
    expect(faultFor("split", "B", "S")).toBeNull();
  });
  it("accepts consistent splits", () => {
    expect(() => validateSplit("buyer_favour", 1000, 0, 1000)).not.toThrow();
    expect(() => validateSplit("seller_favour", 0, 1000, 1000)).not.toThrow();
    expect(() => validateSplit("split", 300, 700, 1000)).not.toThrow();
    expect(() => validateSplit("split", 0, 0, 0)).not.toThrow(); // nothing held (off-platform order)
  });
  it("rejects amounts that do not add up or contradict the outcome", () => {
    expect(() => validateSplit("split", 300, 600, 1000)).toThrow(/equal the amount/);
    expect(() => validateSplit("split", -1, 1001, 1000)).toThrow(/whole paise/);
    expect(() => validateSplit("split", 1.5, 998.5, 1000)).toThrow(/whole paise/);
    expect(() => validateSplit("buyer_favour", 500, 500, 1000)).toThrow(/full amount/);
    expect(() => validateSplit("seller_favour", 500, 500, 1000)).toThrow(/full amount/);
    expect(() => validateSplit("split", 1000, 0, 1000)).toThrow(/both refund and release/);
  });
  it("median handles empty, odd and even samples", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("evidence files", () => {
  it("accepts JPEG photos, PDFs and mock-ASR audio; keys live under the private disputes/ prefix", () => {
    expect(checkUpload({ kind: "photo", bytes: JPEG, mimeType: "image/jpeg" })).toMatchObject({ mime: "image/jpeg", ext: "jpg" });
    expect(checkUpload({ kind: "document", bytes: PDF, mimeType: "application/pdf" })).toMatchObject({ mime: "application/pdf", ext: "pdf" });
    expect(checkUpload({ kind: "voice", bytes: voice("hi"), mimeType: "audio/ogg; codecs=opus" })).toMatchObject({ kind: "voice", ext: "ogg", mime: "audio/ogg" });
    expect(checkUpload({ kind: "voice", bytes: voice("hi"), mimeType: "audio/x-m4a" }).mime).toBe("audio/mp4");
    expect(evidenceKey("d1", "e1", "jpg")).toBe("disputes/d1/e1.jpg");
  });
  it("rejects wrong types by content, empty and oversized files", () => {
    expect(() => checkUpload({ kind: "photo", bytes: PDF, mimeType: "image/jpeg" })).toThrow(/JPEG, PNG or WebP/);
    expect(() => checkUpload({ kind: "document", bytes: JPEG, mimeType: "application/pdf" })).toThrow(/PDF/);
    expect(() => checkUpload({ kind: "voice", bytes: voice("x"), mimeType: "video/mp4" })).toThrow(/Audio must be/);
    expect(() => checkUpload({ kind: "photo", bytes: new Uint8Array(), mimeType: "image/png" })).toThrow(/empty/);
    expect(() => checkUpload({ kind: "photo", bytes: new Uint8Array(8 * 1024 * 1024 + 1), mimeType: "image/png" })).toThrow(/8 MB/);
  });
});
