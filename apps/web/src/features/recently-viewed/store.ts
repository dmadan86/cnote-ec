"use client";
// "Recently viewed" history: the ids of the last products opened on THIS device. Never sent to the server (the rail
// resolves ids to public product facts through GET /api/recently-viewed, which is stateless).
//
// Consent (docs/design/buyer-convenience.md, docs/design/cookie-consent.md): remembering browsing history across visits is
// personalisation, not strictly necessary. `cnote_recent_v1` is registered under the "marketing" category and is written
// ONLY while that category is granted. Without it the history lives in memory for the current page load (so the product
// page you are on still works) and nothing touches storage. Withdrawal clears the key (applyConsent -> clientClearable).
import { useSyncExternalStore } from "react";
import { clientGranted } from "@/features/consent/client";
import { CONSENT_EVENT } from "@/features/consent/state";
import { pushRecent, parseRecent, serializeRecent, type RecentEntry } from "./pure";

export const RECENT_KEY = "cnote_recent_v1";

let memory: RecentEntry[] = [];
let snapshot: readonly string[] = [];
const listeners = new Set<() => void>();
let wired = false;

function read(now = Date.now()): RecentEntry[] {
  if (!clientGranted("marketing")) return memory;
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY), now);
  } catch {
    return memory; // storage blocked
  }
}

function publish(entries: RecentEntry[]) {
  const ids = entries.map((e) => e.id);
  if (ids.length !== snapshot.length || ids.some((id, i) => id !== snapshot[i])) {
    snapshot = ids;
    listeners.forEach((l) => l());
  }
}

function write(entries: RecentEntry[]) {
  memory = entries;
  if (clientGranted("marketing")) {
    try {
      if (entries.length) localStorage.setItem(RECENT_KEY, serializeRecent(entries));
      else localStorage.removeItem(RECENT_KEY);
    } catch {
      /* storage unavailable: the in-memory copy still serves this page load */
    }
  }
  publish(entries);
}

/** Records a product view (most recent first, de-duplicated, capped). */
export function recordView(id: string) {
  if (typeof window === "undefined") return;
  const now = Date.now();
  write(pushRecent(read(now), id, now));
}

/** "Clear history": empties both the stored and the in-memory copy. */
export function clearRecent() {
  write([]);
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  // A consent change (grant, withdraw, another tab) re-reads the right source.
  window.addEventListener(CONSENT_EVENT, () => {
    if (!clientGranted("marketing")) memory = []; // withdrawal forgets the in-memory copy too
    publish(read());
  });
  window.addEventListener("storage", (e) => {
    if (e.key === RECENT_KEY || e.key === null) publish(read());
  });
}

const EMPTY: readonly string[] = [];

/** Recently viewed product ids, newest first. Empty on the server and before hydration (static pages stay static). */
export function useRecentIds(): readonly string[] {
  return useSyncExternalStore(
    (cb) => {
      wire();
      listeners.add(cb);
      publish(read());
      return () => {
        listeners.delete(cb);
      };
    },
    () => snapshot,
    () => EMPTY,
  );
}

/** Test hook: forget module state. */
export function __resetRecentForTests() {
  memory = [];
  snapshot = [];
}
