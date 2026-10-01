// localStorage/sessionStorage persistence for the nudge rules. Every access is guarded: storage can be blocked.
// Marketing-category storage (features/consent/registry.ts): without the visitor's "marketing" consent nothing is
// persisted; the caps then live in memory for this page load only (the nudges keep working, they just do not remember).
import { clientGranted } from "@/features/consent/client";
import { EMPTY_STORE, type NudgeStore } from "./rules";

const KEY = "cnote_lg_v1";
const VIEWS = "cnote_lg_views";
const SESSION_MARK = "cnote_lg_session";

const mem = { store: EMPTY_STORE as NudgeStore, session: false, views: new Set<string>() };

export function loadStore(): NudgeStore {
  if (!clientGranted("marketing")) return mem.store;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY_STORE, ...(JSON.parse(raw) as Partial<NudgeStore>) } : EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}
export function saveStore(s: NudgeStore) {
  if (!clientGranted("marketing")) {
    mem.store = s;
    return;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: caps then apply per page view only */
  }
}

/** True the first time it is called in this browser session (marks the session start). */
export function isNewSession(): boolean {
  if (!clientGranted("marketing")) {
    if (mem.session) return false;
    mem.session = true;
    return true;
  }
  try {
    if (sessionStorage.getItem(SESSION_MARK)) return false;
    sessionStorage.setItem(SESSION_MARK, "1");
    return true;
  } catch {
    return false;
  }
}

/** Adds a product to the session's viewed set and returns the distinct count. */
export function trackView(id: string): number {
  if (!clientGranted("marketing")) {
    mem.views.add(id);
    return mem.views.size;
  }
  try {
    const set = new Set<string>(JSON.parse(sessionStorage.getItem(VIEWS) ?? "[]") as string[]);
    set.add(id);
    sessionStorage.setItem(VIEWS, JSON.stringify([...set].slice(-50)));
    return set.size;
  } catch {
    return 1;
  }
}
