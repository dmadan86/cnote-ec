// Sample approval feeds the supplier trust read model through events (docs/design/samples.md); small samples never move the score.
import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { createBusiness } from "../src";
import { SAMPLE_EXPIRY_MAX_PENALTY, SAMPLE_MAX_PTS, SAMPLE_MIN_EVALUATED, computeTrustScore, emptySignals } from "../src/trust";
import { recomputeTrust, trustHandlers } from "../src/trust-worker";

describe("computeTrustScore: samples", () => {
  const base = { ...emptySignals(1), acceptedFast: 10 };
  const score = (extra: object) => computeTrustScore({ ...base, ...extra }).score;

  it("ignores the approval rate below the minimum number of evaluated samples", () => {
    expect(score({ samplesEvaluated: SAMPLE_MIN_EVALUATED - 1, samplesApproved: 0 })).toBe(score({}));
    expect(score({ samplesEvaluated: SAMPLE_MIN_EVALUATED, samplesApproved: SAMPLE_MIN_EVALUATED })).toBeGreaterThan(score({}));
  });

  it("is bounded by +-SAMPLE_MAX_PTS and neutral around 60% approval", () => {
    const none = score({});
    expect(score({ samplesEvaluated: 100, samplesApproved: 100 }) - none).toBe(SAMPLE_MAX_PTS);
    expect(none - score({ samplesEvaluated: 100, samplesApproved: 0 })).toBe(SAMPLE_MAX_PTS);
    expect(score({ samplesEvaluated: 10, samplesApproved: 6 })).toBe(none);
  });

  it("charges one point per unanswered request, capped", () => {
    const none = score({});
    expect(none - score({ samplesExpired: 2 })).toBe(2);
    expect(none - score({ samplesExpired: 50 })).toBe(SAMPLE_EXPIRY_MAX_PENALTY);
  });

  it("is unchanged when no sample signal exists", () => {
    expect(computeTrustScore(base)).toEqual(computeTrustScore({ ...base, samplesEvaluated: 0, samplesApproved: 0, samplesExpired: 0 }));
  });
});

const bizIds: string[] = [];
const people: string[] = [];
const evIds: number[] = [];
let seq = Math.floor(Math.random() * 1e9) * 100 + 7;
afterAll(async () => {
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
  if (bizIds.length) await redis.del(...bizIds.map((b) => `trust:${b}`));
  if (evIds.length) await redis.del(...evIds.map((e) => `trust:ev:${e}`));
});

describe("trust worker: sample events", () => {
  it("counts verdicts once per event and lowers/raises the stored score", async () => {
    const p = await prisma.person.create({ data: { email: `ts-${randomUUID()}@example.test` } });
    people.push(p.id);
    const { businessId } = await createBusiness(p.id, { name: "Sample Co", isSeller: true });
    bizIds.push(businessId);
    await redis.del(`trust:${businessId}`);
    await recomputeTrust(businessId);
    const start = (await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore;

    const mk = (type: "SampleEvaluated" | "SampleExpired", payload: object) => {
      const id = ++seq;
      evIds.push(id);
      return { id, type, version: 1, aggregateType: "sample", aggregateId: randomUUID(), occurredAt: new Date().toISOString(), payload: { sampleId: randomUUID(), buyerBusinessId: randomUUID(), sellerBusinessId: businessId, ...payload } } as never;
    };
    const rejected = mk("SampleEvaluated", { approved: false, reasons: ["finish_defect"], photoCount: 0 });
    await trustHandlers.SampleEvaluated!(rejected);
    await trustHandlers.SampleEvaluated!(rejected); // redelivery: counted once
    expect(await redis.hget(`trust:${businessId}`, "samplesEvaluated")).toBe("1");
    expect(await redis.hget(`trust:${businessId}`, "samplesApproved")).toBeNull();

    await trustHandlers.SampleEvaluated!(mk("SampleEvaluated", { approved: true, reasons: [], photoCount: 1 }));
    expect(await redis.hget(`trust:${businessId}`, "samplesApproved")).toBe("1");
    // 2 evaluated is below the minimum, so the score has not moved
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore).toBe(start);

    await trustHandlers.SampleExpired!(mk("SampleExpired", {}));
    expect(await redis.hget(`trust:${businessId}`, "samplesExpired")).toBe("1");
    expect((await prisma.business.findUniqueOrThrow({ where: { id: businessId } })).trustScore).toBe(start - 1);
  });
});
