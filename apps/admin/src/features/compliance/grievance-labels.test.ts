import { describe, expect, it } from "vitest";
import { categoryLabel, FILTERS, slaBadges } from "./grievance-labels";

const base = { slaDays: 2 };
const takedown = (o: Partial<{ hoursLeft: number | null; acknowledgement: "done" | "pending" | "breached"; resolution: "closed" | "on_track" | "due_soon" | "breached" }>) =>
  ({ ...base, sla: { kind: "takedown" as const, daysLeft: 1, hoursLeft: 30, acknowledgement: "pending" as const, resolution: "on_track" as const, ...o } });

describe("grievance labels", () => {
  it("labels the report category and lists a takedown filter", () => {
    expect(categoryLabel("report")).toBe("Abuse / IPR takedown");
    expect(categoryLabel("content")).toBe("Content");
    expect(categoryLabel("mystery")).toBe("mystery");
    expect(FILTERS.map((f) => f.key)).toContain("takedown");
  });
});

describe("slaBadges", () => {
  it("takedown: on track shows hours left to act", () => {
    const b = slaBadges(takedown({}));
    expect(b.map((x) => x.text)).toEqual(["Takedown SLA: acknowledge 24h, act 36h", "30 hours left to act", "On track"]);
  });
  it("takedown: singular hour, acknowledgement overdue and due soon", () => {
    expect(slaBadges(takedown({ hoursLeft: 1, resolution: "due_soon" })).map((x) => x.text)).toContain("1 hour left to act");
    const t = slaBadges(takedown({ hoursLeft: 5, acknowledgement: "breached", resolution: "due_soon" }));
    expect(t.find((x) => x.key === "a")).toMatchObject({ tone: "danger", text: "Acknowledgement overdue (24h)" });
    expect(t.find((x) => x.key === "d")).toMatchObject({ tone: "warning", text: "Act within 6 hours" });
    expect(t.find((x) => x.key === "o")).toBeUndefined();
  });
  it("takedown: breached hides the hours-left badge", () => {
    const t = slaBadges(takedown({ hoursLeft: -3, resolution: "breached" }));
    expect(t.map((x) => x.key)).toEqual(["k", "r"]);
    expect(t[1]).toMatchObject({ tone: "danger", text: "Action overdue (36h)" });
  });
  it("takedown: a closed ticket shows only the SLA kind", () => {
    expect(slaBadges(takedown({ hoursLeft: null, acknowledgement: "done", resolution: "closed" })).map((x) => x.key)).toEqual(["k"]);
  });
  it("rights and complaint tickets keep the day-based badges", () => {
    const rights = slaBadges({ slaDays: 90, sla: { kind: "rights", daysLeft: 70, hoursLeft: 1700, acknowledgement: "done", resolution: "on_track" } });
    expect(rights.map((x) => x.text)).toEqual(["Rights SLA 90d", "70 days left", "On track"]);
    const c = slaBadges({ slaDays: 15, sla: { kind: "complaint", daysLeft: 2, hoursLeft: 50, acknowledgement: "breached", resolution: "due_soon" } });
    expect(c.map((x) => x.text)).toEqual(["Complaint SLA 15d", "2 days left", "Acknowledgement overdue", "Due within 3 days"]);
    const late = slaBadges({ slaDays: 15, sla: { kind: "complaint", daysLeft: -1, hoursLeft: -20, acknowledgement: "done", resolution: "breached" } });
    expect(late.map((x) => x.text)).toEqual(["Complaint SLA 15d", "Resolution overdue"]);
  });
});
