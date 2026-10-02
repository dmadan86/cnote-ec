// Anonymous DPDP rights requests must prove control of the contact email (signed link) before staff can act on them.
import { randomUUID } from "node:crypto";
import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fileGrievance, grievanceVerifyToken, listGrievances, respondToGrievance, sweepGrievanceSla, verifyGrievanceContact } from "../src";

const H = 3_600_000;
const D = 24 * H;
const tag = randomUUID().slice(0, 8);
const ticketIds: string[] = [];
const personIds: string[] = [];
const staff = randomUUID();
const email = (n: string) => `gv-${tag}-${n}@example.test`;
const body = { subject: "Erase my data", body: "Please erase everything you hold about me." };
let queue: MemoryJobQueue;

beforeEach(() => {
  queue = new MemoryJobQueue();
  setJobQueue(queue);
});
afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${ticketIds})`;
  await prisma.grievanceTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

async function sentMails() {
  const out: { to: string; subject: string; text: string }[] = [];
  await queue.consume("identity.mail", "t", "c", async (m) => void out.push(m.payload));
  return out;
}
const tokenFrom = (text: string) => decodeURIComponent(/token=([^\s&]+)/.exec(text)![1]!);
async function file(requestType: "access" | "erasure" | "correction" = "erasure", contact = email(randomUUID().slice(0, 5)), now?: Date) {
  const g = await fileGrievance({ ...body, requestType, contactEmail: contact }, now);
  ticketIds.push(g.id);
  return { g, contact };
}

describe("requester email verification", () => {
  it("an anonymous rights request is created unverified and a signed confirmation link is emailed (enqueued)", async () => {
    const { g, contact } = await file("access");
    expect(g.requesterVerified).toBe(false);
    expect(g.sla.acknowledgement).toBe("pending");
    const mails = await sentMails();
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: contact, subject: expect.stringMatching(/Confirm your data request/) });
    expect(mails[0]!.text).toContain(`/grievance/verify?ticket=${g.id}&token=`);
    expect(mails[0]!.text).toContain(g.id);
  });
  it("staff cannot start or resolve it until verified, but can reject it; the staff list shows the verified state", async () => {
    const { g } = await file("erasure");
    await expect(respondToGrievance(g.id, { status: "in_progress" }, staff)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("not verified") });
    await expect(respondToGrievance(g.id, { status: "resolved", resolution: "Erased everything." }, staff)).rejects.toMatchObject({ code: "conflict" });
    const listed = (await listGrievances({ requestType: "erasure", limit: 200 })).find((x) => x.id === g.id)!;
    expect(listed.requesterVerified).toBe(false);
    const rejected = await respondToGrievance(g.id, { status: "rejected", resolution: "Could not verify the requester." }, staff);
    expect(rejected.status).toBe("rejected");
  });
  it("the signed link verifies the requester, restarts the SLA clock at verification, is idempotent, and unlocks staff action", async () => {
    const filedAt = new Date(Date.now() - 2 * D);
    const { g, contact } = await file("access", undefined, filedAt);
    void contact;
    const token = tokenFrom((await sentMails())[0]!.text);
    const now = new Date();
    const r = await verifyGrievanceContact(g.id, token, now);
    expect(r.verified).toBe(true);
    expect(new Date(r.dueAt).getTime()).toBe(now.getTime() + 90 * D);
    const again = await verifyGrievanceContact(g.id, token, new Date(now.getTime() + 1000));
    expect(again.dueAt).toBe(r.dueAt); // idempotent: the clock does not move again
    const row = await prisma.grievanceTicket.findUniqueOrThrow({ where: { id: g.id } });
    expect(row.contactVerifiedAt).not.toBeNull();
    expect((await respondToGrievance(g.id, { status: "in_progress" }, staff)).requesterVerified).toBe(true);
  });
  it("forged, mismatched, tampered and expired links are all the same generic error and verify nothing", async () => {
    const a = await file("access");
    const b = await file("erasure");
    const tokenA = grievanceVerifyToken(a.g.id, a.contact);
    for (const [id, tok] of [
      [a.g.id, grievanceVerifyToken(b.g.id, b.contact)], // another ticket's token
      [a.g.id, `${tokenA.split(".")[0]}.${"A".repeat(43)}`], // forged signature
      [a.g.id, tokenA.replace(/.$/, tokenA.endsWith("A") ? "B" : "A")], // tampered
      [a.g.id, `${Date.now() + 1e9}.${tokenA.split(".")[1]}`], // exp edited without re-signing
      [a.g.id, "garbage"],
      [a.g.id, ""],
      ["not-a-uuid", tokenA],
      [randomUUID(), tokenA],
    ] as const) {
      await expect(verifyGrievanceContact(id, tok)).rejects.toMatchObject({ code: "validation", message: "This confirmation link is invalid or has expired." });
    }
    const expired = grievanceVerifyToken(a.g.id, a.contact, new Date(Date.now() - 8 * D));
    await expect(verifyGrievanceContact(a.g.id, expired)).rejects.toMatchObject({ code: "validation" });
    expect((await prisma.grievanceTicket.findUniqueOrThrow({ where: { id: a.g.id } })).contactVerifiedAt).toBeNull();
  });
  it("signed-in raisers, complaints and takedown notices need no email confirmation", async () => {
    const p = await prisma.person.create({ data: { email: email("p") } });
    personIds.push(p.id);
    const signedIn = await fileGrievance({ ...body, requestType: "erasure", personId: p.id });
    const complaint = await fileGrievance({ ...body, requestType: "complaint", category: "content", contactEmail: email("c") });
    const takedown = await fileGrievance({ ...body, requestType: "complaint", category: "report", contactEmail: email("r") });
    ticketIds.push(signedIn.id, complaint.id, takedown.id);
    expect([signedIn, complaint, takedown].map((g) => g.requesterVerified)).toEqual([true, true, true]);
    expect(await sentMails()).toHaveLength(0);
  });
  it("an unverified ticket is not counted as an SLA breach (the clock only runs once it is actionable)", async () => {
    const { g } = await file("correction", undefined, new Date(Date.now() - 3 * D)); // 3 days old: acknowledgement window long gone
    expect((await listGrievances({ breachedOnly: true, limit: 200 })).some((x) => x.id === g.id)).toBe(false);
    await verifyGrievanceContact(g.id, grievanceVerifyToken(g.id, (await prisma.grievanceTicket.findUniqueOrThrow({ where: { id: g.id } })).contactEmail!));
    await prisma.grievanceTicket.update({ where: { id: g.id }, data: { createdAt: new Date(Date.now() - 3 * D), dueAt: new Date(Date.now() + 80 * D) } });
    expect((await listGrievances({ breachedOnly: true, limit: 200 })).some((x) => x.id === g.id)).toBe(true); // verified + unacknowledged for >24h
  });
  it("the sweep closes anonymous rights requests whose email was never confirmed within 7 days (event emitted)", async () => {
    const { g } = await file("access");
    await prisma.grievanceTicket.update({ where: { id: g.id }, data: { createdAt: new Date(Date.now() - 8 * D) } });
    const r = await sweepGrievanceSla();
    expect(r.unverifiedExpired).toBeGreaterThanOrEqual(1);
    const row = await prisma.grievanceTicket.findUniqueOrThrow({ where: { id: g.id } });
    expect(row).toMatchObject({ status: "rejected" });
    expect(row.resolution).toMatch(/not confirmed within 7 days/);
    expect(await prisma.domainEvent.count({ where: { aggregateId: g.id, type: "GrievanceResolved" } })).toBe(1);
    // a closed, unconfirmed ticket cannot be verified afterwards
    await expect(verifyGrievanceContact(g.id, grievanceVerifyToken(g.id, (await prisma.grievanceTicket.findUniqueOrThrow({ where: { id: g.id } })).contactEmail!))).rejects.toMatchObject({ code: "validation" });
  });
});
