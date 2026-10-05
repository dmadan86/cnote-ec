import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { describe, expect, it } from "vitest";
import {
  cancelRequest, createDelegation, decide, deletePolicy, eraseApprovalsData, exportApprovalsData, getSubjectTrail, listDelegations, listPending, listPolicies, listRequests, listSpend,
  matchPolicy, purgeEndedDelegations, purgeResolvedRequests, recordSpend, requireApproval, revokeDelegation, runSlaSweep, savePolicy, setPolicyEnabled, setSpendLimit, worker,
} from "../src";
import { onMemberRemoved } from "../src/worker";

const HOUR = 3_600_000;
type Role = "owner" | "admin" | "requester" | "approver" | "finance" | "viewer";

async function team(roles: Role[]) {
  const business = await prisma.business.create({ data: { name: `Buyer ${randomUUID().slice(0, 6)}` } });
  const people: string[] = [];
  for (const role of roles) {
    const p = await prisma.person.create({ data: { email: `${randomUUID()}@example.test`, name: role } });
    await prisma.businessMember.create({ data: { businessId: business.id, personId: p.id, role } });
    people.push(p.id);
  }
  return { businessId: business.id, people };
}
const subject = (summary = "Quote Q-1 from Sharma Textiles") => ({ type: "quote", id: randomUUID(), summary });
const events = async (type: string, requestId: string) =>
  (await prisma.domainEvent.findMany({ where: { type }, orderBy: { id: "asc" } })).map((e) => e.payload as Record<string, unknown>).filter((p) => p.requestId === requestId);

describe("requireApproval", () => {
  it("is not required without a matching policy, and below the threshold", async () => {
    const t = await team(["owner", "requester"]);
    expect(await requireApproval({ businessId: t.businessId, actorId: t.people[1]!, action: "quote_accept", amountPaise: 9_000_000, subject: subject() })).toMatchObject({ status: "not_required", requestId: null });
    await savePolicy(t.businessId, t.people[0]!, { name: "Over 50k", action: "quote_accept", minAmountPaise: 5_000_000, levels: [{ role: "owner" }] });
    expect(await requireApproval({ businessId: t.businessId, actorId: t.people[1]!, action: "quote_accept", amountPaise: 4_999_999, subject: subject() })).toMatchObject({ status: "not_required" });
    // a different action is unaffected
    expect(await requireApproval({ businessId: t.businessId, actorId: t.people[1]!, action: "rfq_publish", amountPaise: 9_000_000, subject: subject() })).toMatchObject({ status: "not_required" });
  });

  it("holds above the threshold, resumes on approval, and is idempotent per subject", async () => {
    const t = await team(["owner", "requester", "approver"]);
    const [owner, req, appr] = t.people as [string, string, string];
    await savePolicy(t.businessId, owner, { name: "Over 50k", action: "quote_accept", minAmountPaise: 5_000_000, levels: [{ role: "approver" }] });
    const s = subject();
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 6_000_000, subject: s });
    expect(r.status).toBe("pending");
    const again = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 6_000_000, subject: s });
    expect(again).toMatchObject({ status: "pending", requestId: r.requestId });
    expect(await prisma.approvalRequest.count({ where: { businessId: t.businessId, subjectId: s.id } })).toBe(1);

    const [requested] = await events("ApprovalRequested", r.requestId!);
    expect(requested).toMatchObject({ level: 1, totalLevels: 1, amountPaise: 6_000_000, subjectType: "quote" });
    expect((requested!.approverPersonIds as string[]).sort()).toEqual([owner, appr].sort());

    expect(await decide({ requestId: r.requestId!, deciderId: appr, decision: "approve", comment: "ok" })).toMatchObject({ status: "approved" });
    expect(await events("ApprovalApproved", r.requestId!)).toHaveLength(1);
    expect(await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 6_000_000, subject: s })).toMatchObject({ status: "approved", requestId: r.requestId });
    // a larger amount on the same subject is a new question
    expect((await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 7_000_000, subject: s })).status).toBe("pending");
  });

  it("rejects: needs a reason, ends the chain, and stays rejected", async () => {
    const t = await team(["owner", "requester"]);
    const [owner, req] = t.people as [string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "rfq_publish", minAmountPaise: 0, levels: [{ role: "owner" }] });
    const s = { type: "enquiry", id: randomUUID(), summary: "RFQ: cotton yarn" };
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "rfq_publish", amountPaise: 100, subject: s });
    await expect(decide({ requestId: r.requestId!, deciderId: owner, decision: "reject" })).rejects.toMatchObject({ code: "validation" });
    await decide({ requestId: r.requestId!, deciderId: owner, decision: "reject", comment: "Budget frozen" });
    expect(await events("ApprovalRejected", r.requestId!)).toEqual([expect.objectContaining({ cause: "rejected", deciderPersonId: owner })]);
    expect(await requireApproval({ businessId: t.businessId, actorId: req, action: "rfq_publish", amountPaise: 100, subject: s })).toMatchObject({ status: "rejected", requestId: r.requestId });
    await expect(decide({ requestId: r.requestId!, deciderId: owner, decision: "approve" })).rejects.toMatchObject({ code: "conflict" });
  });

  it("forbids self-approval, even for an owner", async () => {
    const t = await team(["owner", "admin"]);
    const [owner, admin] = t.people as [string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "po_issue", minAmountPaise: 0, levels: [{ role: "admin" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: owner, action: "po_issue", amountPaise: 500, subject: { type: "purchase_order", id: randomUUID(), summary: "PO 1" } });
    expect(r.status).toBe("pending");
    await expect(decide({ requestId: r.requestId!, deciderId: owner, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await decide({ requestId: r.requestId!, deciderId: admin, decision: "approve" })).status).toBe("approved");
  });

  it("a level with its own threshold only applies at or above it", async () => {
    const t = await team(["owner", "requester", "approver", "finance"]);
    const [owner, req] = t.people as [string, string];
    await savePolicy(t.businessId, owner, { name: "Tiered", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "approver" }, { role: "finance", minAmountPaise: 1_000_000 }] });
    const small = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 500_000, subject: subject() });
    const big = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 2_000_000, subject: subject() });
    expect((await prisma.approvalRequest.findUnique({ where: { id: small.requestId! } }))?.levels).toHaveLength(1);
    expect((await prisma.approvalRequest.findUnique({ where: { id: big.requestId! } }))?.levels).toHaveLength(2);
  });

  it("two levels: named approver then finance; finance cannot act first; approver cannot act twice", async () => {
    const t = await team(["owner", "requester", "approver", "finance"]);
    const [owner, req, appr, fin] = t.people as [string, string, string, string];
    await savePolicy(t.businessId, owner, { name: "Two step", action: "po_issue", minAmountPaise: 0, levels: [{ role: "owner", personIds: [appr] }, { role: "finance" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "po_issue", amountPaise: 2_000_000, subject: { type: "purchase_order", id: randomUUID(), summary: "PO 7" } });
    await expect(decide({ requestId: r.requestId!, deciderId: fin, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await decide({ requestId: r.requestId!, deciderId: appr, decision: "approve" })).toEqual({ status: "pending", level: 2 });
    const level2 = (await events("ApprovalRequested", r.requestId!)).at(-1)!;
    expect(level2).toMatchObject({ level: 2, totalLevels: 2 });
    expect(level2.approverPersonIds as string[]).not.toContain(appr);
    await expect(decide({ requestId: r.requestId!, deciderId: appr, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await decide({ requestId: r.requestId!, deciderId: fin, decision: "approve" })).toMatchObject({ status: "approved" });
    const trail = await getSubjectTrail(t.businessId, "purchase_order", (await prisma.approvalRequest.findUnique({ where: { id: r.requestId! } }))!.subjectId);
    expect(trail[0]!.decisions.map((d) => [d.level, d.kind])).toEqual([[1, "approved"], [2, "approved"]]);
  });

  it("auto-approves with a trail when nobody else could decide (one-person business)", async () => {
    const t = await team(["owner"]);
    const [owner] = t.people as [string];
    await savePolicy(t.businessId, owner, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "approver" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: owner, action: "quote_accept", amountPaise: 100, subject: subject() });
    expect(r).toMatchObject({ status: "approved", reason: "no_eligible_approver" });
    const row = await prisma.approvalRequest.findUnique({ where: { id: r.requestId! }, include: { decisions: true } });
    expect(row?.status).toBe("approved");
    expect(row?.decisions.map((d) => d.kind)).toEqual(["auto_approved"]);
    expect(await events("ApprovalApproved", r.requestId!)).toHaveLength(0);
  });

  it("legacy staff members count as requesters and cannot approve", async () => {
    const t = await team(["owner"]);
    const staff = await prisma.person.create({ data: { email: `${randomUUID()}@example.test` } });
    await prisma.businessMember.create({ data: { businessId: t.businessId, personId: staff.id, role: "staff" } });
    await savePolicy(t.businessId, t.people[0]!, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "approver" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: staff.id, action: "quote_accept", amountPaise: 100, subject: subject() });
    expect(r.status).toBe("pending");
    await expect(decide({ requestId: r.requestId!, deciderId: staff.id, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses non-members", async () => {
    const t = await team(["owner"]);
    await expect(requireApproval({ businessId: t.businessId, actorId: randomUUID(), action: "quote_accept", amountPaise: 1, subject: subject() })).rejects.toMatchObject({ code: "forbidden" });
    await expect(requireApproval({ businessId: t.businessId, actorId: t.people[0]!, action: "quote_accept", amountPaise: -1, subject: subject() })).rejects.toMatchObject({ code: "validation" });
  });

  it("the requester can withdraw; others cannot", async () => {
    const t = await team(["owner", "requester", "viewer"]);
    const [owner, req, viewer] = t.people as [string, string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "owner" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });
    await expect(cancelRequest({ requestId: r.requestId!, actorId: viewer })).rejects.toMatchObject({ code: "not_found" });
    await cancelRequest({ requestId: r.requestId!, actorId: req });
    expect((await events("ApprovalRejected", r.requestId!))[0]).toMatchObject({ cause: "cancelled" });
    // a withdrawn request can be raised again for the same subject
    const row = await prisma.approvalRequest.findUnique({ where: { id: r.requestId! } });
    const again = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: { type: row!.subjectType, id: row!.subjectId, summary: "again" } });
    expect(again.status).toBe("pending");
    expect(again.requestId).not.toBe(r.requestId);
  });
});

describe("policies", () => {
  it("picks the most specific threshold, validates, and needs the policy.manage capability", async () => {
    const t = await team(["owner", "requester", "approver"]);
    const [owner, req, appr] = t.people as [string, string, string];
    const low = await savePolicy(t.businessId, owner, { name: "Low", action: "quote_accept", minAmountPaise: 100, levels: [{ role: "approver" }] });
    const high = await savePolicy(t.businessId, owner, { name: "High", action: "quote_accept", minAmountPaise: 10_000, levels: [{ role: "owner" }, { role: "finance" }, { role: "admin" }] });
    expect((await matchPolicy(t.businessId, "quote_accept", 500))?.id).toBe(low.id);
    expect((await matchPolicy(t.businessId, "quote_accept", 10_000))?.id).toBe(high.id);
    expect(await matchPolicy(t.businessId, "quote_accept", 99)).toBeNull();
    await setPolicyEnabled(t.businessId, owner, high.id, false);
    expect((await matchPolicy(t.businessId, "quote_accept", 10_000))?.id).toBe(low.id);

    await expect(savePolicy(t.businessId, req, { name: "x", action: "po_issue", minAmountPaise: 0, levels: [{ role: "owner" }] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(savePolicy(t.businessId, appr, { name: "x", action: "po_issue", minAmountPaise: 0, levels: [{ role: "owner" }] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(savePolicy(t.businessId, owner, { name: "x", action: "po_issue", minAmountPaise: 0, levels: [] })).rejects.toMatchObject({ code: "validation" });
    await expect(savePolicy(t.businessId, owner, { name: "x", action: "po_issue", minAmountPaise: 0, levels: [{ role: "owner" }, { role: "owner" }, { role: "owner" }, { role: "owner" }] })).rejects.toMatchObject({ code: "validation" });
    await expect(savePolicy(t.businessId, owner, { name: "x", action: "po_issue", minAmountPaise: 0, levels: [{ role: "approver", personIds: [randomUUID()] }] })).rejects.toMatchObject({ code: "validation" });

    const edited = await savePolicy(t.businessId, owner, { id: low.id, name: "Low v2", action: "quote_accept", minAmountPaise: 200, levels: [{ role: "finance" }] });
    expect(edited).toMatchObject({ name: "Low v2", minAmountPaise: 200, levels: [{ level: 1, role: "finance" }] });
    expect((await listPolicies(t.businessId)).map((p) => p.name).sort()).toEqual(["High", "Low v2"]);
    await deletePolicy(t.businessId, owner, high.id);
    expect(await listPolicies(t.businessId)).toHaveLength(1);

    // another business cannot touch it
    const other = await team(["owner"]);
    await expect(savePolicy(other.businessId, other.people[0]!, { id: low.id, name: "hijack", action: "po_issue", minAmountPaise: 0, levels: [{ role: "owner" }] })).rejects.toMatchObject({ code: "not_found" });
    await expect(deletePolicy(other.businessId, other.people[0]!, low.id)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("spend limits", () => {
  it("over the monthly cap forces an admin sign-off even without a policy; recordSpend is idempotent", async () => {
    const t = await team(["owner", "requester", "finance"]);
    const [owner, req, fin] = t.people as [string, string, string];
    await expect(setSpendLimit({ businessId: t.businessId, actorPersonId: req, personId: req, monthlyCapPaise: 1 })).rejects.toMatchObject({ code: "forbidden" });
    await setSpendLimit({ businessId: t.businessId, actorPersonId: fin, personId: req, monthlyCapPaise: 1_000_000 });

    const a = subject();
    expect((await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 600_000, subject: a })).status).toBe("not_required");
    expect(await recordSpend({ businessId: t.businessId, personId: req, amountPaise: 600_000, action: "quote_accept", subject: a })).toEqual({ recorded: true });
    expect(await recordSpend({ businessId: t.businessId, personId: req, amountPaise: 600_000, action: "quote_accept", subject: a })).toEqual({ recorded: false });
    expect((await listSpend(t.businessId)).find((x) => x.personId === req)).toMatchObject({ capPaise: 1_000_000, spentPaise: 600_000 });

    const b = subject();
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 500_000, subject: b });
    expect(r).toMatchObject({ status: "pending", reason: "spend_limit" });
    // only owner/admin satisfy the escalation level, not finance
    await expect(decide({ requestId: r.requestId!, deciderId: fin, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await decide({ requestId: r.requestId!, deciderId: owner, decision: "approve" })).status).toBe("approved");

    // a purchase that does not commit money (an RFQ) is not subject to the cap
    expect((await requireApproval({ businessId: t.businessId, actorId: req, action: "rfq_publish", amountPaise: 9_000_000, subject: subject() })).status).toBe("not_required");
    await expect(recordSpend({ businessId: t.businessId, personId: req, amountPaise: 1, action: "rfq_publish", subject: a })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("delegation", () => {
  it("lets a delegate decide while the window is open, logs on whose behalf, and never helps the requester", async () => {
    const t = await team(["owner", "requester", "approver", "requester"]);
    const [owner, req, appr, deleg] = t.people as [string, string, string, string];
    await savePolicy(t.businessId, owner, { name: "Named", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "approver", personIds: [appr] }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });
    // not yet delegated
    expect(await listPending({ businessId: t.businessId, personId: deleg })).toHaveLength(0);
    await expect(decide({ requestId: r.requestId!, deciderId: deleg, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });

    const now = new Date();
    await expect(createDelegation({ businessId: t.businessId, delegatorPersonId: req, delegatePersonId: deleg, startsAt: now, endsAt: new Date(now.getTime() + HOUR) })).rejects.toMatchObject({ code: "forbidden" });
    await expect(createDelegation({ businessId: t.businessId, delegatorPersonId: appr, delegatePersonId: appr, startsAt: now, endsAt: new Date(now.getTime() + HOUR) })).rejects.toMatchObject({ code: "validation" });
    const d = await createDelegation({ businessId: t.businessId, delegatorPersonId: appr, delegatePersonId: deleg, startsAt: new Date(now.getTime() - HOUR), endsAt: new Date(now.getTime() + 24 * HOUR) });
    expect((await listDelegations(t.businessId)).map((x) => x.id)).toContain(d.id);
    const pending = await listPending({ businessId: t.businessId, personId: deleg });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.onBehalfOfPersonId).toBe(appr);

    expect((await decide({ requestId: r.requestId!, deciderId: deleg, decision: "approve" })).status).toBe("approved");
    const dec = await prisma.approvalDecision.findFirst({ where: { requestId: r.requestId! } });
    expect(dec).toMatchObject({ deciderPersonId: deleg, onBehalfOfPersonId: appr });

    // the requester cannot be the delegate of an approver to approve their own request
    const r2 = await requireApproval({ businessId: t.businessId, actorId: deleg, action: "quote_accept", amountPaise: 100, subject: subject() });
    await expect(decide({ requestId: r2.requestId!, deciderId: deleg, decision: "approve" })).rejects.toMatchObject({ code: "forbidden" });

    await revokeDelegation({ businessId: t.businessId, actorPersonId: appr, delegationId: d.id });
    expect(await listPending({ businessId: t.businessId, personId: deleg })).toHaveLength(0);
    await expect(revokeDelegation({ businessId: t.businessId, actorPersonId: appr, delegationId: d.id })).rejects.toMatchObject({ code: "not_found" });
  });

  it("an expired window grants nothing", async () => {
    const t = await team(["owner", "requester", "approver", "viewer"]);
    const [owner, req, appr, deleg] = t.people as [string, string, string, string];
    await savePolicy(t.businessId, owner, { name: "Named", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "approver", personIds: [appr] }] });
    await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });
    const now = new Date();
    await prisma.approvalDelegation.create({ data: { businessId: t.businessId, delegatorPersonId: appr, delegatePersonId: deleg, startsAt: new Date(now.getTime() - 48 * HOUR), endsAt: new Date(now.getTime() - HOUR) } });
    expect(await listPending({ businessId: t.businessId, personId: deleg })).toHaveLength(0);
  });
});

describe("SLA sweep", () => {
  it("reminds after the SLA (bounded), then expires", async () => {
    const t = await team(["owner", "requester"]);
    const [owner, req] = t.people as [string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "owner" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });

    expect(await runSlaSweep(new Date(Date.now() + HOUR))).toMatchObject({ reminded: expect.any(Number) });
    expect(await events("ApprovalReminder", r.requestId!)).toHaveLength(0); // not due yet

    const day = 24 * HOUR;
    await runSlaSweep(new Date(Date.now() + day + HOUR));
    expect(await events("ApprovalReminder", r.requestId!)).toHaveLength(1);
    await runSlaSweep(new Date(Date.now() + day + HOUR)); // same instant again: nothing moves (dueAt was pushed out)
    expect(await events("ApprovalReminder", r.requestId!)).toHaveLength(1);
    await runSlaSweep(new Date(Date.now() + 2 * day + 2 * HOUR));
    expect(await events("ApprovalReminder", r.requestId!)).toHaveLength(2);
    expect((await events("ApprovalReminder", r.requestId!))[1]).toMatchObject({ reminderNo: 2, approverPersonIds: [owner] });

    const out = await runSlaSweep(new Date(Date.now() + 8 * day));
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect((await prisma.approvalRequest.findUnique({ where: { id: r.requestId! } }))?.status).toBe("expired");
    expect((await events("ApprovalRejected", r.requestId!))[0]).toMatchObject({ cause: "expired", deciderPersonId: null });
  });
});

describe("worker, privacy and the append-only log", () => {
  it("a removed requester's open requests are withdrawn and their delegations end", async () => {
    const t = await team(["owner", "requester", "approver"]);
    const [owner, req, appr] = t.people as [string, string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "owner" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });
    await setSpendLimit({ businessId: t.businessId, actorPersonId: owner, personId: req, monthlyCapPaise: 5 });
    await prisma.approvalDelegation.create({ data: { businessId: t.businessId, delegatorPersonId: appr, delegatePersonId: req, startsAt: new Date(), endsAt: new Date(Date.now() + 5 * HOUR) } });
    await worker.handlers.BuyerMemberRemoved!({ id: 1, type: "BuyerMemberRemoved", version: 1, aggregateType: "business", aggregateId: t.businessId, occurredAt: "", payload: { businessId: t.businessId, personId: req, removedByPersonId: owner } } as never);
    await onMemberRemoved(t.businessId, req); // idempotent
    expect((await prisma.approvalRequest.findUnique({ where: { id: r.requestId! } }))?.status).toBe("cancelled");
    expect(await listDelegations(t.businessId)).toHaveLength(0);
    expect(await prisma.memberSpendLimit.count({ where: { businessId: t.businessId } })).toBe(0);
  });

  it("the decision log cannot be rewritten; erasure only nulls the comment", async () => {
    const t = await team(["owner", "requester"]);
    const [owner, req] = t.people as [string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "owner" }] });
    const r = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });
    await decide({ requestId: r.requestId!, deciderId: owner, decision: "approve", comment: "looks fine, call me on 98765 43210" });
    const dec = await prisma.approvalDecision.findFirst({ where: { requestId: r.requestId! } });
    await expect(prisma.approvalDecision.update({ where: { id: dec!.id }, data: { kind: "rejected" } })).rejects.toThrow(/append-only/);
    await expect(prisma.approvalDecision.update({ where: { id: dec!.id }, data: { comment: "edited" } })).rejects.toThrow(/append-only/);

    const exported = (await exportApprovalsData(owner)) as { approvalDecisions: { comment: string | null }[] };
    expect(exported.approvalDecisions[0]!.comment).toContain("98765");
    await eraseApprovalsData(owner);
    await eraseApprovalsData(owner); // idempotent
    expect((await prisma.approvalDecision.findUnique({ where: { id: dec!.id } }))?.comment).toBeNull();
    expect((await prisma.approvalDecision.findUnique({ where: { id: dec!.id } }))?.deciderPersonId).toBe(owner);
  });

  it("retention purges only old resolved records and ended delegations", async () => {
    const t = await team(["owner", "requester"]);
    const [owner, req] = t.people as [string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "owner" }] });
    const old = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });
    const open = await requireApproval({ businessId: t.businessId, actorId: req, action: "quote_accept", amountPaise: 100, subject: subject() });
    await decide({ requestId: old.requestId!, deciderId: owner, decision: "approve" });
    const cutoff = new Date(Date.now() + HOUR);
    expect(await purgeResolvedRequests(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    await purgeResolvedRequests(cutoff);
    expect(await prisma.approvalRequest.findUnique({ where: { id: old.requestId! } })).toBeNull();
    expect(await prisma.approvalDecision.count({ where: { requestId: old.requestId! } })).toBe(0);
    expect((await prisma.approvalRequest.findUnique({ where: { id: open.requestId! } }))?.status).toBe("pending");
    await prisma.approvalDelegation.create({ data: { businessId: t.businessId, delegatorPersonId: owner, delegatePersonId: req, startsAt: new Date(Date.now() - 5 * HOUR), endsAt: new Date(Date.now() - 4 * HOUR) } });
    expect(await purgeEndedDelegations(cutoff, { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect(await purgeEndedDelegations(cutoff)).toBeGreaterThanOrEqual(1);
  });

  it("lists my requests and the whole business for managers only", async () => {
    const t = await team(["owner", "requester", "requester"]);
    const [owner, a, b] = t.people as [string, string, string];
    await savePolicy(t.businessId, owner, { name: "All", action: "quote_accept", minAmountPaise: 0, levels: [{ role: "owner" }] });
    await requireApproval({ businessId: t.businessId, actorId: a, action: "quote_accept", amountPaise: 100, subject: subject() });
    await requireApproval({ businessId: t.businessId, actorId: b, action: "quote_accept", amountPaise: 100, subject: subject() });
    expect(await listRequests({ businessId: t.businessId, personId: a, scope: "mine" })).toHaveLength(1);
    expect(await listRequests({ businessId: t.businessId, personId: a, scope: "all" })).toHaveLength(1); // not a manager: still only their own
    expect(await listRequests({ businessId: t.businessId, personId: owner, scope: "all" })).toHaveLength(2);
    expect(await listPending({ businessId: t.businessId, personId: owner })).toHaveLength(2);
    expect(await listRequests({ businessId: t.businessId, personId: randomUUID(), scope: "all" })).toEqual([]);
  });
});
