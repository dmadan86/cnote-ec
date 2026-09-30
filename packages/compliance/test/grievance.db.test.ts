import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it, vi } from "vitest";
import { evaluateSla, fileGrievance, getGrievance, getMyGrievance, listGrievances, listMyGrievances, respondToGrievance, sweepGrievanceSla } from "../src";

const H = 3_600_000;
const D = 24 * H;
const tag = randomUUID().slice(0, 8);
const personIds: string[] = [];
const ticketIds: string[] = [];
const staff = randomUUID();
const email = (n: string) => `grv-${tag}-${n}@example.test`;
const t0 = new Date("2026-01-01T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

async function person() {
  const p = await prisma.person.create({ data: { email: email(randomUUID().slice(0, 5)) } });
  personIds.push(p.id);
  return p.id;
}
const valid = { category: "access" as const, subject: "Copy of my data", body: "Please send me a copy of all my data." };

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${ticketIds})`;
  await prisma.grievanceTicket.deleteMany({ where: { id: { in: ticketIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("fileGrievance", () => {
  it("validates input and requires a way to reply", async () => {
    await expect(fileGrievance({ ...valid, subject: "x", contactEmail: email("a") })).rejects.toMatchObject({ code: "validation" });
    await expect(fileGrievance({ ...valid, body: "short", contactEmail: email("a") })).rejects.toMatchObject({ code: "validation" });
    await expect(fileGrievance({ ...valid })).rejects.toMatchObject({ code: "validation", details: { field: "contactEmail" } });
    await expect(fileGrievance({ ...valid, category: "nope" as never, contactEmail: email("a") })).rejects.toMatchObject({ code: "validation" });
    await expect(fileGrievance({ ...valid, contactEmail: "not-an-email" })).rejects.toMatchObject({ code: "validation" });
  });

  it("creates a ticket with the policy dueAt, masks contact, emits GrievanceFiled", async () => {
    const g = await fileGrievance({ ...valid, contactEmail: email("Anon").toUpperCase() }, t0);
    ticketIds.push(g.id);
    expect(g.status).toBe("open");
    expect(g.contactEmail).toMatch(/^g\*\*\*@/);
    expect(new Date(g.dueAt).getTime() - t0.getTime()).toBe(15 * D);
    expect((await prisma.grievanceTicket.findUniqueOrThrow({ where: { id: g.id } })).contactEmail).toBe(email("Anon").toLowerCase());
    const ev = await prisma.domainEvent.findFirst({ where: { type: "GrievanceFiled", aggregateId: g.id } });
    expect(ev?.payload).toMatchObject({ ticketId: g.id, category: "access", personId: null });
  });

  it("rate limits per raiser", async () => {
    const p = await person();
    for (let i = 0; i < 5; i++) ticketIds.push((await fileGrievance({ ...valid, personId: p })).id);
    await expect(fileGrievance({ ...valid, personId: p })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("lifecycle + SLA with a fake clock", () => {
  it("open → acknowledged → resolved, with SLA states over time", async () => {
    const p = await person();
    const g = await fileGrievance({ ...valid, personId: p, category: "erasure" }, t0);
    ticketIds.push(g.id);
    expect(evaluateSla({ status: "open", createdAt: t0, dueAt: at(15 * D) }, at(1 * H))).toEqual({ acknowledgement: "pending", resolution: "on_track" });
    expect((await getGrievance(g.id, at(25 * H)))!.sla.acknowledgement).toBe("breached");
    expect((await getGrievance(g.id, at(13 * D)))!.sla.resolution).toBe("due_soon");
    expect((await getGrievance(g.id, at(16 * D)))!.sla.resolution).toBe("breached");

    await expect(respondToGrievance(g.id, { status: "resolved" }, staff)).rejects.toMatchObject({ code: "validation" });
    await expect(respondToGrievance(g.id, { status: "resolved", resolution: "Erased" }, "bad")).rejects.toMatchObject({ code: "forbidden" });
    await expect(respondToGrievance(randomUUID(), { status: "in_progress" }, staff)).rejects.toMatchObject({ code: "not_found" });

    const ack = await respondToGrievance(g.id, { status: "in_progress" }, staff, at(2 * H));
    expect(ack.status).toBe("in_progress");
    expect(ack.sla.acknowledgement).toBe("done");
    expect(ack.resolvedAt).toBeNull();
    expect(await prisma.domainEvent.count({ where: { type: "GrievanceResolved", aggregateId: g.id } })).toBe(0);

    const done = await respondToGrievance(g.id, { status: "resolved", resolution: "Your data has been erased." }, staff, at(3 * H));
    expect(done).toMatchObject({ status: "resolved", resolution: "Your data has been erased.", handledBy: staff });
    expect(done.sla.resolution).toBe("closed");
    const ev = await prisma.domainEvent.findFirst({ where: { type: "GrievanceResolved", aggregateId: g.id } });
    expect(ev?.payload).toMatchObject({ status: "resolved", personId: p });
    await expect(respondToGrievance(g.id, { status: "rejected", resolution: "too late" }, staff)).rejects.toMatchObject({ code: "conflict" });
  });

  it("concurrent closers: only one wins", async () => {
    const g = await fileGrievance({ ...valid, contactEmail: email("race") }, t0);
    ticketIds.push(g.id);
    const rs = await Promise.allSettled([1, 2].map(() => respondToGrievance(g.id, { status: "rejected", resolution: "Not applicable" }, staff)));
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("list filters, breachedOnly, my grievances and ownership", async () => {
    const p = await person();
    const other = await person();
    const a = await fileGrievance({ ...valid, personId: p, category: "consent" }, t0);
    const b = await fileGrievance({ ...valid, personId: p, category: "other" }, at(20 * D));
    ticketIds.push(a.id, b.id);
    const now = at(21 * D);
    const breached = (await listGrievances({ breachedOnly: true, limit: 200 }, now)).map((x) => x.id);
    expect(breached).toContain(a.id);
    expect(breached).not.toContain(b.id);
    expect((await listGrievances({ status: "open", category: "consent", limit: 200 }, now)).map((x) => x.id)).toContain(a.id);
    expect((await listGrievances({}, now)).length).toBeGreaterThan(0);
    const mine = await listMyGrievances(p);
    expect(mine.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(await listMyGrievances("bad")).toEqual([]);
    expect(await getMyGrievance(p, a.id)).not.toBeNull();
    expect(await getMyGrievance(other, a.id)).toBeNull();
    expect(await getMyGrievance("bad", a.id)).toBeNull();
    expect(await getGrievance("bad")).toBeNull();
    expect(await getGrievance(randomUUID())).toBeNull();
  });

  it("sweep counts breaches and logs a warning", async () => {
    const g = await fileGrievance({ ...valid, contactEmail: email("sweep") }, t0);
    ticketIds.push(g.id);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await sweepGrievanceSla(at(16 * D));
    expect(r.ackBreached).toBeGreaterThanOrEqual(1);
    expect(r.resolutionBreached).toBeGreaterThanOrEqual(1);
    expect(warn).toHaveBeenCalled();
    const soon = await sweepGrievanceSla(at(13 * D));
    expect(soon.dueSoon).toBeGreaterThanOrEqual(1);
    warn.mockRestore();
    const quiet = await sweepGrievanceSla(new Date("2000-01-01"));
    expect(quiet).toEqual({ ackBreached: 0, resolutionBreached: 0, dueSoon: 0 });
  });
});
