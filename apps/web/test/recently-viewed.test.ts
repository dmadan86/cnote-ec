import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSENT_COOKIE, CONSENT_POLICY_VERSION, serializeConsent } from "@/features/consent/state";
import { STORAGE_REGISTRY, clientClearable } from "@/features/consent/registry";
import { parseRecent, pushRecent, RECENT_MAX, RECENT_MAX_AGE_MS, serializeRecent } from "@/features/recently-viewed/pure";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = 1_800_000_000_000;

describe("recently viewed: pure list", () => {
  it("puts the newest first, de-duplicates and caps", () => {
    let list = pushRecent([], ID(1), NOW);
    list = pushRecent(list, ID(2), NOW + 1);
    list = pushRecent(list, ID(1), NOW + 2);
    expect(list.map((e) => e.id)).toEqual([ID(1), ID(2)]);
    for (let i = 10; i < 10 + RECENT_MAX + 5; i++) list = pushRecent(list, ID(i), NOW + i);
    expect(list).toHaveLength(RECENT_MAX);
  });
  it("ignores anything that is not a uuid", () => {
    expect(pushRecent([], "../etc/passwd", NOW)).toEqual([]);
    expect(pushRecent([], "<script>", NOW)).toEqual([]);
  });
  it("parse is tolerant: garbage, wrong version, duplicates, expired and future entries are dropped", () => {
    expect(parseRecent(null, NOW)).toEqual([]);
    expect(parseRecent("not json", NOW)).toEqual([]);
    expect(parseRecent(JSON.stringify({ v: 2, items: [{ id: ID(1), at: NOW }] }), NOW)).toEqual([]);
    const raw = JSON.stringify({
      v: 1,
      items: [{ id: ID(1), at: NOW - 10 }, { id: ID(1), at: NOW - 5 }, { id: ID(2), at: NOW - RECENT_MAX_AGE_MS - 1 }, { id: ID(3), at: NOW + 3_600_000 }, { id: "x", at: NOW }, null],
    });
    expect(parseRecent(raw, NOW).map((e) => e.id)).toEqual([ID(1)]);
  });
  it("round-trips", () => {
    const list = pushRecent(pushRecent([], ID(1), NOW), ID(2), NOW + 1);
    expect(parseRecent(serializeRecent(list), NOW + 2)).toEqual(list);
  });
});

describe("recently viewed: consent registration", () => {
  it("is registered as functional localStorage (not strictly necessary) and cleared on withdrawal", () => {
    const e = STORAGE_REGISTRY.find((x) => x.name === "cnote_recent_v1");
    expect(e).toMatchObject({ category: "functional", kind: "localStorage", purpose: "recentlyViewed" });
    expect(clientClearable("functional").map((x) => x.name)).toContain("cnote_recent_v1");
  });
});

const consentCookie = (functional: boolean) =>
  `${CONSENT_COOKIE}=${serializeConsent({ version: CONSENT_POLICY_VERSION, id: "c".repeat(32), analytics: false, marketing: false, functional, gpc: false, at: Math.floor(Date.now() / 1000) - 5 })}`;

function browser(cookie: string) {
  const m = new Map<string, string>();
  const local = { getItem: (k: string) => m.get(k) ?? null, setItem: vi.fn((k: string, v: string) => void m.set(k, v)), removeItem: (k: string) => void m.delete(k) };
  vi.stubGlobal("document", { cookie });
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", { addEventListener: () => undefined, removeEventListener: () => undefined });
  return { local, m };
}

describe("recently viewed: storage follows consent", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("writes NOTHING to storage without functional consent, but keeps the list in memory for the page", async () => {
    const b = browser("");
    const s = await import("@/features/recently-viewed/store");
    s.recordView(ID(1));
    s.recordView(ID(2));
    expect(b.local.setItem).not.toHaveBeenCalled();
    expect(b.m.size).toBe(0);
  });

  it("writes cnote_recent_v1 once functional is granted, and clearing removes it", async () => {
    const b = browser(consentCookie(true));
    const s = await import("@/features/recently-viewed/store");
    s.recordView(ID(1));
    expect(b.local.setItem).toHaveBeenCalledWith("cnote_recent_v1", expect.stringContaining(ID(1)));
    s.clearRecent();
    expect(b.m.has("cnote_recent_v1")).toBe(false);
  });

  it("does not write when functional was explicitly rejected", async () => {
    const b = browser(consentCookie(false));
    const s = await import("@/features/recently-viewed/store");
    s.recordView(ID(1));
    expect(b.local.setItem).not.toHaveBeenCalled();
  });
});
