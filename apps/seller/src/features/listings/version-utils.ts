import type { VersionOverview, VersionView } from "@cnote/catalogue";

export const VERSION_STATUS: Record<VersionView["status"], { label: string; tone: "neutral" | "success" | "warning" | "danger" | "brand" }> = {
  submitted: { label: "Submitted", tone: "warning" },
  in_review: { label: "In review", tone: "warning" },
  approved: { label: "Approved, going live", tone: "brand" },
  published: { label: "Live", tone: "success" },
  superseded: { label: "Replaced", tone: "neutral" },
  rejected: { label: "Rejected", tone: "danger" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

/** "Live: v3 · Pending: v4 in review" */
export function versionSummary(o: Pick<VersionOverview, "live" | "pending">): string {
  const pending = o.pending ? `Pending: v${o.pending.version} ${o.pending.status === "approved" ? (o.pending.publishAt ? "approved, scheduled" : "approved, going live") : "in review"}` : null;
  const live = o.live ? `Live: v${o.live.version}` : null;
  if (live && pending) return `${live} · ${pending}`;
  if (live) return live;
  if (pending) return `Not live yet · ${pending}`;
  return "Not live";
}
