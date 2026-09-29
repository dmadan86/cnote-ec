// localStorage/sessionStorage persistence for the nudge rules. Every access is guarded: storage can be blocked.
import { EMPTY_STORE, type NudgeStore } from "./rules";

const KEY = "cnote_lg_v1";
const VIEWS = "cnote_lg_views";
const SESSION_MARK = "cnote_lg_session";

export function loadStore(): NudgeStore {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY_STORE, ...(JSON.parse(raw) as Partial<NudgeStore>) } : EMPTY_STORE;
  } catch {
    return EMPTY_STORE;
  }
}
export function saveStore(s: NudgeStore) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: caps then apply per page view only */
  }
}

/** True the first time it is called in this browser session (marks the session start). */
export function isNewSession(): boolean {
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
  try {
    const set = new Set<string>(JSON.parse(sessionStorage.getItem(VIEWS) ?? "[]") as string[]);
    set.add(id);
    sessionStorage.setItem(VIEWS, JSON.stringify([...set].slice(-50)));
    return set.size;
  } catch {
    return 1;
  }
}
