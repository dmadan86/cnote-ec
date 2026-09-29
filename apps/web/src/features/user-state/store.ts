"use client";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Per-user state (session, saved items, compare tray) for the otherwise fully static, CDN-cacheable buyer pages.
 * Fetched once per page load from GET /api/me (private, no-store) and shared by every island: header account menu,
 * heart buttons, compare toggles and the compare tray. Nothing personal is ever rendered into cached HTML.
 */
export interface CompareItem {
  id: string;
  title: string;
  image: string | null;
}

export interface UserState {
  status: "idle" | "loading" | "ready" | "error";
  signedIn: boolean;
  name: string | null;
  email: string | null;
  isSeller: boolean;
  savedIds: readonly string[];
  savedCount: number;
  compareIds: readonly string[];
  compareItems: readonly CompareItem[];
}

const INITIAL: UserState = { status: "idle", signedIn: false, name: null, email: null, isSeller: false, savedIds: [], savedCount: 0, compareIds: [], compareItems: [] };

let state: UserState = INITIAL;
let inflight: Promise<void> | null = null;
let loadedAt = 0;
const listeners = new Set<() => void>();

const set = (next: Partial<UserState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

/** (Re)loads the state from the server. Concurrent calls share one request. */
export function refreshUserState(): Promise<void> {
  if (inflight) return inflight;
  if (state.status === "idle") set({ status: "loading" });
  inflight = fetch("/api/me", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as Omit<UserState, "status">;
      loadedAt = Date.now();
      set({ ...d, status: "ready" });
    })
    .catch(() => set({ status: state.status === "ready" ? "ready" : "error" }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Call before a server action on a static page: server actions POST to the page URL, which bypasses the auth proxy, so
 * an access token that expired while the tab sat open would otherwise look signed-out. /api/me runs behind the proxy and
 * rotates the tokens. No-op when the state is recent.
 */
export async function ensureFresh(maxAgeMs = 5 * 60_000): Promise<void> {
  if (Date.now() - loadedAt > maxAgeMs) await refreshUserState();
}

/** Optimistic local updates after a toggle succeeded on the server (keeps every island in sync without a refetch). */
export function markSaved(id: string, saved: boolean) {
  const has = state.savedIds.includes(id);
  if (saved === has) return;
  const savedIds = saved ? [...state.savedIds, id] : state.savedIds.filter((x) => x !== id);
  set({ savedIds, savedCount: Math.max(0, state.savedCount + (saved ? 1 : -1)) });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Subscribe to the shared per-user state; the first mounted consumer triggers the fetch. */
export function useUserState(): UserState {
  const s = useSyncExternalStore(subscribe, () => state, () => INITIAL);
  useEffect(() => {
    if (state.status === "idle") void refreshUserState();
  }, []);
  return s;
}
