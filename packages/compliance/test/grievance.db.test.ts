import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { evaluateSla, fileGrievance, REQUEST_TYPES, getGrievance, getMyGrievance, listGrievances, listMyGrievances, respondToGrievance, sweepGrievanceSla } from "../src";

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

afterEach(() => vi.useRealTimers());

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
    expect(new Date(g.dueAt).getTime() - t0.getTime()).toBe(90 * D); // legacy category "access" is a rights request
    expect((await prisma.grievanceTicket.findUniqueOrThrow({ where: { id: g.id } })).contactEmail).toBe(email("Anon").toLowerCase());
    const ev = await prisma.domainEvent.findFirst({ where: { type: "GrievanceFiled", aggregateId: g.id } });
    expect(ev?.payload).toMatchObject({ ticketId: g.id, category: "access", personId: null });
  });

  it("rate limits per raiser", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); // fixed-window limiter: a real minute/hour boundary mid-test would reset the counter
    const p = await person();
    for (let i = 0; i < 5; i++) ticketIds.push((await fileGrievance({ ...valid, personId: p })).id);
    await expect(fileGrievance({ ...valid, personId: p })).rejects.toMatchObject({ code: "rate_limited" });
  });
});

describe("lifecycle + SLA with a fake clock", () => {
  it("open → acknowledged → resolved, with SLA states over time", async () => {
    const p = await person();
    const g = await fileGrievance({ ...valid, personId: p, requestType: "complaint", category: "other" }, t0);
    ticketIds.push(g.id);
    expect(evaluateSla({ status: "open", createdAt: t0, dueAt: at(15 * D) }, at(1 * H))).toMatchObject({ kind: "complaint", acknowledgement: "pending", resolution: "on_track" });
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

describe("data-rights requests", () => {
  it("knows the six request types", () => {
    expect([...REQUEST_TYPES]).toEqual(["access", "correction", "erasure", "nomination", "withdraw_consent", "complaint"]);
  });
  it("rights requests are due in 90 days, complaints in the grievance window; category is derived", async () => {
    const rows = await Promise.all(REQUEST_TYPES.map((requestType) => fileGrievance({ ...valid, requestType, category: requestType === "complaint" ? "content" : undefined, contactEmail: email(`rt-${requestType}`) }, t0)));
    ticketIds.push(...rows.map((r) => r.id));
    for (const g of rows) {
      const rights = g.requestType !== "complaint";
      expect(g.slaDays, g.requestType).toBe(rights ? 90 : 15);
      expect(new Date(g.dueAt).getTime() - t0.getTime()).toBe(g.slaDays * D);
      expect(g.sla.kind).toBe(rights ? "rights" : "complaint");
    }
    const byType = Object.fromEntries(rows.map((g) => [g.requestType, g.category]));
    expect(byType).toEqual({ access: "access", correction: "correction", erasure: "erasure", nomination: "other", withdraw_consent: "consent", complaint: "content" });
  });
  it("reports days left and flips to breached after the rights window, not the complaint window", async () => {
    const g = await fileGrievance({ ...valid, requestType: "access", contactEmail: email("sla90") }, t0);
    ticketIds.push(g.id);
    expect((await getGrievance(g.id, at(16 * D)))!.sla).toMatchObject({ kind: "rights", resolution: "on_track", daysLeft: 74 });
    expect((await getGrievance(g.id, at(88 * D)))!.sla.resolution).toBe("due_soon");
    expect((await getGrievance(g.id, at(91 * D)))!.sla).toMatchObject({ resolution: "breached", daysLeft: -1 });
  });
  it("stores an optional cookie consent id and rejects a malformed one", async () => {
    const id = "d".repeat(32);
    const g = await fileGrievance({ ...valid, requestType: "withdraw_consent", consentId: id.toUpperCase(), contactEmail: email("cid") });
    ticketIds.push(g.id);
    expect(g.consentId).toBe(id);
    await expect(fileGrievance({ ...valid, requestType: "withdraw_consent", consentId: "xyz", contactEmail: email("cid2") })).rejects.toMatchObject({ code: "validation" });
    await expect(fileGrievance({ subject: "Something wrong", body: "No type or category here.", contactEmail: email("none") })).rejects.toMatchObject({ code: "validation" });
  });
  it("lists rights requests that are still open", async () => {
    const a = await fileGrievance({ ...valid, requestType: "correction", contactEmail: email("lr1") }, t0);
    const b = await fileGrievance({ ...valid, requestType: "complaint", category: "other", contactEmail: email("lr2") }, t0);
    ticketIds.push(a.id, b.id);
    const ids = (await listGrievances({ rightsOnly: true, limit: 200 }, t0)).map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
  it("resolving an erasure request detaches that person's cookie-consent receipts (anonymous proof kept); other outcomes do not", async () => {
    const p = await person();
    const cid = randomUUID().replace(/-/g, "");
    await prisma.cookieConsentReceipt.create({ data: { consentId: cid, policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom", locale: "en", personId: p } });
    const g = await fileGrievance({ ...valid, personId: p, requestType: "erasure" }, t0);
    ticketIds.push(g.id);
    await respondToGrievance(g.id, { status: "in_progress" }, staff);
    expect((await prisma.cookieConsentReceipt.findFirstOrThrow({ where: { consentId: cid } })).personId).toBe(p);
    await respondToGrievance(g.id, { status: "resolved", resolution: "Your data has been erased." }, staff);
    expect(await prisma.cookieConsentReceipt.findFirstOrThrow({ where: { consentId: cid } })).toMatchObject({ personId: null, analytics: true });

    const q = await person();
    const cid2 = randomUUID().replace(/-/g, "");
    await prisma.cookieConsentReceipt.create({ data: { consentId: cid2, policyVersion: 1, analytics: true, marketing: false, gpc: false, action: "custom", locale: "en", personId: q } });
    const rej = await fileGrievance({ ...valid, personId: q, requestType: "erasure" }, t0);
    ticketIds.push(rej.id);
    await respondToGrievance(rej.id, { status: "rejected", resolution: "Retention is required by law." }, staff);
    expect((await prisma.cookieConsentReceipt.findFirstOrThrow({ where: { consentId: cid2 } })).personId).toBe(q);
    await prisma.cookieConsentReceipt.deleteMany({ where: { consentId: { in: [cid, cid2] } } });
  });
});

describe("takedown notices (category report, IT Rules 2021 r.3(1)(d))", () => {
  const notice = { category: "report" as const, requestType: "complaint" as const, subject: "Counterfeit listing", body: "This listing sells counterfeit goods under our brand." };
  it("is acted on within 36 hours: dueAt is hour-based and slaDays is the rounded-up window", async () => {
    const g = await fileGrievance({ ...notice, contactEmail: email("td1") }, t0);
    ticketIds.push(g.id);
    expect(new Date(g.dueAt).getTime() - t0.getTime()).toBe(36 * H);
    expect(g.slaDays).toBe(2);
    expect(g.sla).toMatchObject({ kind: "takedown", acknowledgement: "pending", resolution: "on_track", hoursLeft: 36 });
  });
  it("acknowledgement window is 24h, due soon is the last 6h, breach after 36h", async () => {
    const g = await fileGrievance({ ...notice, contactEmail: email("td2") }, t0);
    ticketIds.push(g.id);
    expect((await getGrievance(g.id, at(23 * H)))!.sla.acknowledgement).toBe("pending");
    expect((await getGrievance(g.id, at(25 * H)))!.sla).toMatchObject({ acknowledgement: "breached", resolution: "on_track", hoursLeft: 11 });
    expect((await getGrievance(g.id, at(31 * H)))!.sla.resolution).toBe("due_soon");
    expect((await getGrievance(g.id, at(37 * H)))!.sla).toMatchObject({ resolution: "breached", hoursLeft: -1 });
    await respondToGrievance(g.id, { status: "resolved", resolution: "The listing was removed." }, staff);
    expect((await getGrievance(g.id, at(40 * H)))!.sla).toMatchObject({ resolution: "closed", hoursLeft: null, acknowledgement: "done" });
  });
  it("other categories keep their own windows (complaint 15d, ack 24h, due soon 3d)", () => {
    const base = { status: "open" as const, createdAt: t0, dueAt: at(15 * D) };
    expect(evaluateSla({ ...base, category: "content", requestType: "complaint" }, at(13 * D))).toMatchObject({ kind: "complaint", resolution: "due_soon", hoursLeft: 48 });
    expect(evaluateSla({ ...base, category: "report" }, at(13 * D)).kind).toBe("takedown");
  });
  it("breachedOnly applies the 24h takedown acknowledgement and the sweep counts it", async () => {
    const g = await fileGrievance({ ...notice, contactEmail: email("td3") }, t0);
    const c = await fileGrievance({ ...valid, requestType: "complaint", category: "other", contactEmail: email("td4") }, t0);
    ticketIds.push(g.id, c.id);
    const ids = (await listGrievances({ breachedOnly: true, limit: 200 }, at(25 * H))).map((x) => x.id);
    expect(ids).toContain(g.id); // takedown unacknowledged after 25h
    expect(ids).toContain(c.id); // ordinary complaint too (24h ack)
    const s = await sweepGrievanceSla(at(25 * H));
    expect(s.ackBreached).toBeGreaterThanOrEqual(2);
  });
  it("openOnly lists the working queue of takedowns", async () => {
    const a = await fileGrievance({ ...notice, contactEmail: email("td5") }, t0);
    const b = await fileGrievance({ ...notice, contactEmail: email("td6") }, t0);
    ticketIds.push(a.id, b.id);
    await respondToGrievance(b.id, { status: "rejected", resolution: "Not infringing, no action." }, staff);
    const ids = (await listGrievances({ category: "report", openOnly: true, limit: 200 }, t0)).map((x) => x.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});
