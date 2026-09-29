import { describe, expect, it } from "vitest";
import { EMPTY_STORE, recordDismissed, recordShown, shouldNudge } from "./rules";

const now = 1_800_000_000_000;
const base = { now, store: EMPTY_STORE, signedIn: false, desktop: true, viewsInSession: 4 };

describe("nudge rules", () => {
  it("fires on the 4th distinct product view, not before", () => {
    expect(shouldNudge({ ...base, kind: "product_views", viewsInSession: 3 })).toBe(false);
    expect(shouldNudge({ ...base, kind: "product_views" })).toBe(true);
  });
  it("never nudges signed-in users or first pageviews via exit intent", () => {
    expect(shouldNudge({ ...base, kind: "product_views", signedIn: true })).toBe(false);
    expect(shouldNudge({ ...base, kind: "exit_intent", viewsInSession: 1 })).toBe(false);
  });
  it("exit intent is desktop only", () => {
    expect(shouldNudge({ ...base, kind: "exit_intent", desktop: false })).toBe(false);
    expect(shouldNudge({ ...base, kind: "exit_intent" })).toBe(true);
  });
  it("caps to one per day and three per week", () => {
    expect(shouldNudge({ ...base, kind: "product_views", store: recordShown(EMPTY_STORE, now - 3600_000) })).toBe(false);
    const week = { ...EMPTY_STORE, shown: [now - 2 * 86_400_000, now - 3 * 86_400_000, now - 4 * 86_400_000] };
    expect(shouldNudge({ ...base, kind: "product_views", store: week })).toBe(false);
  });
  it("cools down after dismissal: 7 days, then 30 after a repeat", () => {
    const once = recordDismissed(EMPTY_STORE, "product_views", now - 8 * 86_400_000);
    expect(shouldNudge({ ...base, kind: "product_views", store: recordDismissed(EMPTY_STORE, "product_views", now - 86_400_000) })).toBe(false);
    expect(shouldNudge({ ...base, kind: "product_views", store: once })).toBe(true);
    const twice = recordDismissed(once, "product_views", now - 8 * 86_400_000);
    expect(shouldNudge({ ...base, kind: "product_views", store: twice })).toBe(false);
  });
  it("return visit needs a prior session 1-7 days ago", () => {
    expect(shouldNudge({ ...base, kind: "return_visit", viewsInSession: 2 })).toBe(false);
    expect(shouldNudge({ ...base, kind: "return_visit", viewsInSession: 2, store: { ...EMPTY_STORE, visits: [now - 2 * 86_400_000] } })).toBe(true);
  });
});
