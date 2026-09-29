// Soft-nudge rules engine (pure, unit-tested). High-intent triggers (Get best price, Contact seller, Request quote)
// are user-initiated clicks and need no rule. Nudges are never modal and never fire on page load or first pageview.
// See docs/design/lead-generation.md.
export type NudgeKind = "product_views" | "return_visit" | "exit_intent";

export interface NudgeStore {
  /** epoch ms of every nudge shown (pruned to 7 days) */
  shown: number[];
  dismissed: Partial<Record<NudgeKind, { n: number; at: number }>>;
  /** epoch ms of session starts (last 10) */
  visits: number[];
}
export const EMPTY_STORE: NudgeStore = { shown: [], dismissed: {}, visits: [] };

const DAY = 86_400_000;
export const CAPS = { perDay: 1, perWeek: 3, cooldownAfterDismissDays: 7, cooldownAfterRepeatDismissDays: 30, productViews: 4 } as const;

export interface NudgeInput {
  kind: NudgeKind;
  now: number;
  store: NudgeStore;
  signedIn: boolean;
  desktop: boolean;
  /** distinct product pages viewed this session */
  viewsInSession: number;
}

export function shouldNudge(i: NudgeInput): boolean {
  if (i.signedIn) return false;
  const { store, now } = i;
  if (store.shown.filter((t) => now - t < DAY).length >= CAPS.perDay) return false;
  if (store.shown.filter((t) => now - t < 7 * DAY).length >= CAPS.perWeek) return false;
  const d = store.dismissed[i.kind];
  if (d) {
    const cooldown = (d.n >= 2 ? CAPS.cooldownAfterRepeatDismissDays : CAPS.cooldownAfterDismissDays) * DAY;
    if (now - d.at < cooldown) return false;
  }
  switch (i.kind) {
    case "product_views":
      return i.viewsInSession >= CAPS.productViews;
    case "return_visit": {
      // a previous session within 7 days but at least a day ago, and this session already shows interest
      const prior = store.visits.filter((t) => now - t >= DAY && now - t < 7 * DAY);
      return prior.length > 0 && i.viewsInSession >= 2;
    }
    case "exit_intent":
      return i.desktop && i.viewsInSession >= 2;
  }
}

export const recordShown = (s: NudgeStore, now: number): NudgeStore => ({ ...s, shown: [...s.shown.filter((t) => now - t < 7 * DAY), now] });
export const recordDismissed = (s: NudgeStore, kind: NudgeKind, now: number): NudgeStore => ({
  ...s,
  dismissed: { ...s.dismissed, [kind]: { n: (s.dismissed[kind]?.n ?? 0) + 1, at: now } },
});
export const recordVisit = (s: NudgeStore, now: number): NudgeStore => ({ ...s, visits: [...s.visits, now].slice(-10) });
