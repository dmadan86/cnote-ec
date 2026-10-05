// Fake-lead signals and labels: failure and empty-state behaviour (complements reachability-risk.db.test.ts).
import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  MockReachabilityProvider, exportFakeLeadLabelsCsv, fakeLeadPrecisionRecall, handleReachabilityCallback, labelEnquiry, labelledRows, listLabelQueue, recordSignals,
  setReachabilityProvider, signReachabilityCallback, purgeEnquirySignals, collectSignals,
} from "../src";

const people: string[] = [];
const bizs: string[] = [];
const enquiries: string[] = [];

async function enquiry(intentScore: number | null) {
  const p = await prisma.person.create({ data: { email: `re-${randomUUID()}@example.test`, name: "Buyer" } });
  const b = await prisma.business.create({ data: { name: `Buyer ${randomUUID().slice(0, 6)}` } });
  people.push(p.id); bizs.push(b.id);
  const e = await prisma.enquiry.create({ data: { buyerBusinessId: b.id, buyerPersonId: p.id, title: "Steel rods", requirement: "Need 500 kg of 10 mm TMT rods", intentScore } });
  enquiries.push(e.id);
  return e.id;
}

afterAll(async () => {
  setReachabilityProvider(undefined);
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: enquiries } } });
  await prisma.enquirySignals.deleteMany({ where: { enquiryId: { in: enquiries } } });
  await prisma.enquiry.deleteMany({ where: { id: { in: enquiries } } });
  await prisma.business.deleteMany({ where: { id: { in: bizs } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
});

describe("collecting signals", () => {
  it("never throws: a storage failure yields no signals", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await collectSignals("not-a-uuid", { ip: "203.0.113.5", userAgent: "Mozilla/5.0 Firefox/121" })).toBeNull();
      expect(warn).toHaveBeenCalledWith("[enquiry] fake-lead signals unavailable", expect.any(String));
    } finally {
      warn.mockRestore();
    }
  });

  it("without an ip there is no network lookup and the risk says so", async () => {
    const e = await enquiry(50);
    const owner = await prisma.enquiry.findUniqueOrThrow({ where: { id: e }, select: { buyerPersonId: true } });
    const s = (await collectSignals(owner.buyerPersonId, { userAgent: "curl/8", phoneVerified: true }))!;
    expect(s).toMatchObject({ ipHash: null, uaFamily: "script", velocityIp24h: 0, velocityPerson1h: 1 });
    expect(s.risk.reasons).toEqual(expect.arrayContaining(["Posted by a script, not a browser", "No network address"]));
    await prisma.$transaction((tx) => recordSignals(tx, e, s));
    expect((await prisma.enquirySignals.findUniqueOrThrow({ where: { enquiryId: e } })).riskScore).toBe(s.risk.score);
  });
});

describe("labels", () => {
  it("labelling an enquiry that has no signals row creates one; a low intent score alone predicts fake", async () => {
    const e = await enquiry(5);
    const staff = randomUUID();
    expect(await labelEnquiry(e, "spam", staff)).toEqual({ label: "spam", predictedFake: true });
    expect(await prisma.enquirySignals.findUniqueOrThrow({ where: { enquiryId: e } })).toMatchObject({ label: "spam", labelledBy: staff, riskScore: 0, uaFamily: "none" });
    // re-labelling updates the same row
    expect(await labelEnquiry(e, "genuine", staff)).toEqual({ label: "genuine", predictedFake: true });
    expect((await prisma.enquirySignals.findUniqueOrThrow({ where: { enquiryId: e } })).label).toBe("genuine");
  });

  it("a high intent score and no risk is predicted genuine; a null intent score does not predict fake", async () => {
    const e = await enquiry(null);
    expect((await labelEnquiry(e, "genuine", randomUUID())).predictedFake).toBe(false);
    const f = await enquiry(90);
    expect((await labelEnquiry(f, "fake", randomUUID())).predictedFake).toBe(false);
  });

  it("lists the queue unlabelled by default, honours bounds, and filters rows by labelled-at window", async () => {
    const e = await enquiry(60);
    await prisma.enquirySignals.create({ data: { enquiryId: e, uaFamily: "bot", riskScore: 99, riskReasons: ["Automated browser signature"] } });
    const q = await listLabelQueue({ limit: 1000 });
    expect(q.find((i) => i.enquiryId === e)).toMatchObject({ riskScore: 99, label: null, uaFamily: "bot" });
    expect((await listLabelQueue({ limit: 0 })).length).toBeLessThanOrEqual(1);
    expect((await listLabelQueue({ labelled: true })).every((i) => i.label !== null)).toBe(true);

    await labelEnquiry(e, "fake", randomUUID());
    const now = Date.now();
    const inWindow = await labelledRows({ since: new Date(now - 60_000), until: new Date(now + 60_000) });
    expect(inWindow.find((r) => r.enquiryId === e)).toMatchObject({ label: "fake", isFake: true, riskScore: 99, predictedFake: true, reachability: "none" });
    expect((await labelledRows({ since: new Date(now + 3_600_000) })).find((r) => r.enquiryId === e)).toBeUndefined();
    expect((await labelledRows({ until: new Date(now - 3_600_000) })).find((r) => r.enquiryId === e)).toBeUndefined();
    expect((await labelledRows({ limit: 1 })).length).toBe(1);

    const csv = await exportFakeLeadLabelsCsv({ since: new Date(now - 60_000) });
    expect(csv).toContain(e);
    expect(csv).not.toContain("Steel rods");
    const pr = await fakeLeadPrecisionRecall({ since: new Date(now - 60_000) });
    expect(pr.truePositive).toBeGreaterThanOrEqual(1);
  });

  it("retention nulls the ip hash only for old signals", async () => {
    const e = await enquiry(60);
    await prisma.enquirySignals.create({ data: { enquiryId: e, uaFamily: "chrome-android", riskScore: 0, riskReasons: [], ipHash: "h".repeat(16) } });
    expect(await purgeEnquirySignals(new Date(0))).toBe(0);
    expect(await purgeEnquirySignals(new Date(Date.now() + 60_000), { dryRun: true })).toBeGreaterThanOrEqual(1);
    expect((await prisma.enquirySignals.findUniqueOrThrow({ where: { enquiryId: e } })).ipHash).not.toBeNull();
    await purgeEnquirySignals(new Date(Date.now() + 60_000));
    expect((await prisma.enquirySignals.findUniqueOrThrow({ where: { enquiryId: e } })).ipHash).toBeNull();
  });
});

describe("telephony callbacks", () => {
  const SECRET = "edge-secret";
  const body = (providerRef: string) => JSON.stringify({ providerRef, outcome: "confirmed" });

  it("acknowledges a reference it does not know so the vendor stops retrying", async () => {
    setReachabilityProvider(new MockReachabilityProvider(SECRET));
    const raw = body(`mock_${randomUUID()}`);
    expect(await handleReachabilityCallback(raw, { "x-reachability-signature": signReachabilityCallback(SECRET, raw) }, new URLSearchParams())).toEqual({ checkId: null, outcome: "unknown_reference" });
  });
});
