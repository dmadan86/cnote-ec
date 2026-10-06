import type { DomainEvent } from "@cnote/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cnote/templates", () => ({ defineTemplates: () => {}, isChannelEnabled: async () => true, renderText: async () => ({ title: "t", body: "b" }) }));
vi.mock("@cnote/email", () => ({ sendEmail: async () => "id" }));
vi.mock("@cnote/identity", () => ({ BADGE_THRESHOLD: 40, getConsents: async () => ({ marketing: false }) }));

import { getKind, templateDefinitions } from "../src/kinds";
import { APPROVAL_KINDS } from "../src/kinds-approvals";

const ev = (type: string, payload: unknown): DomainEvent => ({ id: 1, type, version: 1, aggregateType: "x", aggregateId: "x", occurredAt: "", payload }) as never;
const run = (key: string, event: DomainEvent) => getKind(key)!.resolve(event as never, {} as never);
const base = { requestId: "r1", businessId: "b1", action: "quote_accept", subjectType: "quote", subjectId: "q1", subjectSummary: "Quote\nfor yarn", amountPaise: 15_000_000, requesterPersonId: "req" };

describe("approval and team notification kinds", () => {
  it("are registered with Hindi seed copy and valid template variables", () => {
    for (const k of APPROVAL_KINDS) {
      expect(getKind(k.key), k.key).toBeDefined();
      expect(k.localized?.hi?.in_app?.body, k.key).toBeTruthy();
      const names = new Set(k.variables.map((v) => v.name));
      for (const c of [k.defaults.in_app, k.defaults.email!, k.localized!.hi!.in_app!]) {
        for (const m of `${c.subject ?? ""} ${c.body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) expect(names, `${k.key} uses {{${m[1]}}}`).toContain(m[1]);
      }
    }
    expect(templateDefinitions().filter((d) => d.key.startsWith("approval.")).every((d) => d.category === "transactional")).toBe(true);
  });

  it("asks the approvers, never the requester, and links to the request", async () => {
    const r = await run("approval.requested", ev("ApprovalRequested", { ...base, level: 1, totalLevels: 2, approverPersonIds: ["a1", "req", "a2"] }));
    expect(r.map((x) => x.personId).sort()).toEqual(["a1", "a2"]);
    expect(r[0]).toMatchObject({ href: "/buyer/approvals/r1", vars: { subject: "Quote for yarn", amount: "₹1,50,000" } });
    const rem = await run("approval.reminder", ev("ApprovalReminder", { requestId: "r1", businessId: "b1", subjectSummary: "X", level: 1, reminderNo: 1, approverPersonIds: ["a1"] }));
    expect(rem.map((x) => x.personId)).toEqual(["a1"]);
  });

  it("tells the requester about the outcome, split by cause", async () => {
    expect((await run("approval.approved", ev("ApprovalApproved", base))).map((x) => x.personId)).toEqual(["req"]);
    const rejected = ev("ApprovalRejected", { ...base, cause: "rejected", deciderPersonId: "a1" });
    expect((await run("approval.rejected", rejected)).map((x) => x.personId)).toEqual(["req"]);
    expect(await run("approval.expired", rejected)).toEqual([]);
    const expired = ev("ApprovalRejected", { ...base, cause: "expired", deciderPersonId: null });
    expect((await run("approval.expired", expired)).map((x) => x.personId)).toEqual(["req"]);
    expect(await run("approval.rejected", expired)).toEqual([]);
    expect(await run("approval.rejected", ev("ApprovalRejected", { ...base, cause: "cancelled", deciderPersonId: "req" }))).toEqual([]);
  });

  it("notifies team changes only to the affected person and not for self-service", async () => {
    expect((await run("team.role_changed", ev("BuyerMemberRoleChanged", { businessId: "b1", personId: "p1", from: "viewer", to: "approver", changedByPersonId: "o1" }))).map((x) => x.personId)).toEqual(["p1"]);
    expect(await run("team.role_changed", ev("BuyerMemberRoleChanged", { businessId: "b1", personId: "o1", from: "owner", to: "owner", changedByPersonId: "o1" }))).toEqual([]);
    expect((await run("team.removed", ev("BuyerMemberRemoved", { businessId: "b1", personId: "p1", removedByPersonId: "o1" }))).map((x) => x.personId)).toEqual(["p1"]);
    expect(await run("team.removed", ev("BuyerMemberRemoved", { businessId: "b1", personId: "p1", removedByPersonId: "p1" }))).toEqual([]);
    expect((await run("team.ownership_transferred", ev("BusinessOwnershipTransferred", { businessId: "b1", fromPersonId: "o1", toPersonId: "n1" }))).map((x) => x.personId)).toEqual(["n1"]);
  });
});
