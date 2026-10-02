// Labels, filters and SLA badges of the admin grievance queue (pure, so they are unit-tested without rendering).
import type { GrievanceView } from "@cnote/compliance";

export const FILTERS = [
  { key: "open", label: "Open" },
  { key: "rights", label: "Data rights requests" },
  { key: "takedown", label: "Takedown notices" },
  { key: "in_progress", label: "In progress" },
  { key: "breached", label: "SLA breached" },
  { key: "resolved", label: "Resolved" },
  { key: "rejected", label: "Closed without action" },
] as const;
export type GrievanceFilterKey = (typeof FILTERS)[number]["key"];

export const TYPE_LABEL: Record<string, string> = {
  access: "Access request", correction: "Correction request", erasure: "Erasure request", nomination: "Nomination", withdraw_consent: "Withdraw consent", complaint: "Complaint",
};

/** Grievance category as shown to staff. "report" = abuse / IPR takedown notice from the public /report page. */
export const CATEGORY_LABEL: Record<string, string> = {
  access: "Access", correction: "Correction", erasure: "Erasure", consent: "Consent", content: "Content", other: "Other",
  report: "Abuse / IPR takedown",
};
export const categoryLabel = (c: string): string => CATEGORY_LABEL[c] ?? c;

export type BadgeTone = "neutral" | "accent" | "danger" | "warning" | "success";
export interface SlaBadge { key: string; tone: BadgeTone; text: string }

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** SLA status of one ticket. Takedown notices (IT Rules 2021 r.3(1)(d)) run in hours: acknowledge in 24h, act in 36h. */
export function slaBadges(g: Pick<GrievanceView, "slaDays" | "sla">): SlaBadge[] {
  const out: SlaBadge[] = [];
  const { sla } = g;
  if (sla.kind === "takedown") {
    out.push({ key: "k", tone: "danger", text: "Takedown SLA: acknowledge 24h, act 36h" });
    if (sla.hoursLeft !== null && sla.resolution !== "breached") out.push({ key: "l", tone: "neutral", text: `${plural(sla.hoursLeft, "hour")} left to act` });
    if (sla.acknowledgement === "breached") out.push({ key: "a", tone: "danger", text: "Acknowledgement overdue (24h)" });
    if (sla.resolution === "breached") out.push({ key: "r", tone: "danger", text: "Action overdue (36h)" });
    else if (sla.resolution === "due_soon") out.push({ key: "d", tone: "warning", text: "Act within 6 hours" });
    else if (sla.resolution === "on_track" && sla.acknowledgement !== "breached") out.push({ key: "o", tone: "success", text: "On track" });
    return out;
  }
  out.push({ key: "k", tone: sla.kind === "rights" ? "accent" : "neutral", text: sla.kind === "rights" ? `Rights SLA ${g.slaDays}d` : `Complaint SLA ${g.slaDays}d` });
  if (sla.daysLeft !== null && sla.resolution !== "breached") out.push({ key: "l", tone: "neutral", text: `${sla.daysLeft} days left` });
  if (sla.acknowledgement === "breached") out.push({ key: "a", tone: "danger", text: "Acknowledgement overdue" });
  if (sla.resolution === "breached") out.push({ key: "r", tone: "danger", text: "Resolution overdue" });
  else if (sla.resolution === "due_soon") out.push({ key: "d", tone: "warning", text: "Due within 3 days" });
  else if (sla.resolution === "on_track" && sla.acknowledgement !== "breached") out.push({ key: "o", tone: "success", text: "On track" });
  return out;
}
