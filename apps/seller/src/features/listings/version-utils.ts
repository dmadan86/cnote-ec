import type { VersionOverview, VersionView } from "@cnote/catalogue";

/** Minimal translator shape (next-intl's `t` for the `listings` namespace fits it). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Tone per version status; the label is `listings.versionStatus.<status>`. */
export const VERSION_STATUS: Record<VersionView["status"], { tone: "neutral" | "success" | "warning" | "danger" | "brand" }> = {
  submitted: { tone: "warning" },
  in_review: { tone: "warning" },
  approved: { tone: "brand" },
  published: { tone: "success" },
  superseded: { tone: "neutral" },
  rejected: { tone: "danger" },
  withdrawn: { tone: "neutral" },
};

/** "Live: v3 · Pending: v4 in review" */
export function versionSummary(o: Pick<VersionOverview, "live" | "pending">, t: Translate): string {
  const pending = o.pending
    ? t(o.pending.status === "approved" ? (o.pending.publishAt ? "summary.pendingScheduled" : "summary.pendingApproved") : "summary.pendingReview", { version: o.pending.version })
    : null;
  const live = o.live ? t("summary.live", { version: o.live.version }) : null;
  if (live && pending) return t("summary.both", { live, pending });
  if (live) return live;
  if (pending) return t("summary.notLiveYet", { pending });
  return t("summary.notLive");
}
