import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@cnote/enquiry", () => ({
  createEnquiry: async (_a: unknown, input: unknown) => {
    created.calls.push(input);
    return { id: "00000000-0000-4000-8000-000000000001" };
  },
}));

import { completeUnlock, funnelByTriggerDay, markConverted, markOtpSent, markVerified, startCapture, sweepAbandoned } from "../src";

const vid = () => `vid_${randomUUID().replace(/-/g, "")}`;
const capIds: string[] = [];
const personIds: string[] = [];
const phone = `+9190${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

async function person(verified = true) {
  const p = await prisma.person.create({ data: { phone: verified ? phone : null, phoneVerifiedAt: verified ? new Date() : null } });
  personIds.push(p.id);
  const b = await prisma.business.create({ data: { name: `lg-test-${p.id}` } });
  await prisma.businessMember.create({ data: { businessId: b.id, personId: p.id } });
  return p.id;
}

afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM domain_events WHERE aggregate_id = ANY(${capIds}) OR aggregate_id = ANY(${personIds})`;
  await prisma.leadCapture.deleteMany({ where: { id: { in: capIds } } });
  const biz = (await prisma.businessMember.findMany({ where: { personId: { in: personIds } }, select: { businessId: true } })).map((m) => m.businessId);
  await prisma.businessMember.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.business.deleteMany({ where: { id: { in: biz } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

const start = async (o: Partial<Parameters<typeof startCapture>[0]> = {}) => {
  const { captureId } = await startCapture({ visitorId: vid(), trigger: "pdp_best_price", unlock: "enquiry", attribution: { utm_source: "g" }, ...o });
  capIds.push(captureId);
  return captureId;
};

describe("lead capture lifecycle", () => {
  it("goes start -> otp_sent -> verified -> converted, storing only a phone hash and emitting events", async () => {
    const id = await start();
    await markOtpSent(id, phone);
    const row = await prisma.leadCapture.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("otp_sent");
    expect(row.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(phone);

    const pid = await person();
    await expect(markVerified(id, pid, true, "+919999999999")).rejects.toThrow(/does not match/);
    await markVerified(id, pid, true, phone);
    await markVerified(id, pid, true, phone); // idempotent
    const res = await completeUnlock(pid, id, { quantity: 50, quantityUnit: "kg" });
    expect(res.kind).toBe("enquiry");
    expect((await prisma.leadCapture.findUniqueOrThrow({ where: { id } })).status).toBe("converted");
    const ev = await prisma.domainEvent.findMany({ where: { aggregateId: id }, select: { type: true } });
    expect(ev.map((e) => e.type).sort()).toEqual(["LeadCaptureConverted", "LeadCaptureVerified"]);
  });

  it("refuses unlock for unverified captures and other people's captures", async () => {
    const id = await start({ unlock: "seller_contact", trigger: "pdp_contact_seller" });
    const pid = await person(false);
    await expect(completeUnlock(pid, id)).rejects.toThrow();
    const other = await person(false);
    await markVerified(id, pid, false);
    await expect(completeUnlock(other, id)).rejects.toThrow(/another account/);
  });

  it("marks stale captures abandoned and only counts follow-ups with consent", async () => {
    const a = await start({ followUpConsent: true });
    await markOtpSent(a, phone);
    const b = await start();
    await prisma.leadCapture.updateMany({ where: { id: { in: [a, b] } }, data: { updatedAt: new Date(Date.now() - 31 * 60_000) } });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const r = await sweepAbandoned();
    spy.mockRestore();
    expect(r.abandoned).toBeGreaterThanOrEqual(2);
    expect(r.followUpsQueued).toBeGreaterThanOrEqual(1);
    expect((await prisma.leadCapture.findUniqueOrThrow({ where: { id: b } })).status).toBe("abandoned");
  });

  it("aggregates the funnel by trigger and day", async () => {
    const id = await start({ trigger: "request_quote", unlock: "quotes" });
    await markOtpSent(id, phone);
    const rows = await funnelByTriggerDay(new Date(Date.now() - 86400_000), new Date(Date.now() + 86400_000));
    const row = rows.find((r) => r.trigger === "request_quote");
    expect(row && row.started >= 1 && row.otpSent >= 1).toBe(true);
    void markConverted;
  });
});
