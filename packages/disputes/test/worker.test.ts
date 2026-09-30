import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runBrief, collectEvidence, runAdvanceJob, purge } = vi.hoisted(() => ({
  runBrief: vi.fn(async () => "briefed"),
  collectEvidence: vi.fn(async () => 1),
  runAdvanceJob: vi.fn(async () => undefined),
  purge: vi.fn(async () => 3),
}));
vi.mock("../src/brief", () => ({ runBrief, collectEvidence }));
vi.mock("../src/sla", () => ({ runAdvanceJob }));
vi.mock("../src/retention", () => ({ purgeResolvedDisputeEvidence: purge }));

import { worker } from "../src/worker";
import { BRIEF_TOPIC, COLLECT_TOPIC, enqueueBrief, enqueueCollect } from "../src/jobs";
import { MemoryJobQueue, setJobQueue, type QueueMessage } from "@cnote/core";

const msg = (disputeId: string) => ({ payload: { disputeId } }) as QueueMessage<{ disputeId: string }>;

describe("disputes worker", () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.DISPUTES_ENABLED = "true"; });
  afterEach(() => { delete process.env.DISPUTES_ENABLED; setJobQueue(undefined); });

  it("declares its name, the advance and retention jobs and both queue consumers", () => {
    expect(worker.name).toBe("disputes");
    expect(worker.handlers).toEqual({});
    expect(worker.jobs.map((j) => j.name)).toEqual(["disputes.advance", "disputes.purge-evidence"]);
    expect(worker.queues!.map((q) => q.topic).sort()).toEqual([BRIEF_TOPIC, COLLECT_TOPIC].sort());
  });

  it("consumers call the handlers while enabled and are no-ops while disabled", async () => {
    const collect = worker.queues!.find((q) => q.topic === COLLECT_TOPIC)!;
    const brief = worker.queues!.find((q) => q.topic === BRIEF_TOPIC)!;
    await collect.handler(msg("d1") as never);
    await brief.handler(msg("d2") as never);
    expect(collectEvidence).toHaveBeenCalledWith("d1");
    expect(runBrief).toHaveBeenCalledWith("d2");
    process.env.DISPUTES_ENABLED = "false";
    await collect.handler(msg("d3") as never);
    await brief.handler(msg("d4") as never);
    expect(collectEvidence).toHaveBeenCalledTimes(1);
    expect(runBrief).toHaveBeenCalledTimes(1);
  });

  it("schedules the advance loop every 5 minutes and purges with the retention window", async () => {
    const [advance, purgeJob] = worker.jobs;
    expect(advance!.everyMs).toBe(300_000);
    await advance!.run();
    expect(runAdvanceJob).toHaveBeenCalled();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await purgeJob!.run();
    expect(purge).toHaveBeenCalledTimes(1);
    const cutoff = (purge.mock.calls[0] as unknown as [Date])[0];
    expect(Date.now() - cutoff.getTime()).toBeGreaterThan(1094 * 86_400_000);
    expect(log).toHaveBeenCalled();
    purge.mockResolvedValueOnce(0);
    await purgeJob!.run();
    log.mockRestore();
  });

  it("enqueue helpers dedupe and never throw when the queue is down", async () => {
    const q = new MemoryJobQueue();
    setJobQueue(q);
    const spy = vi.spyOn(q, "enqueue");
    await enqueueCollect("d1");
    await enqueueCollect("d1");
    await enqueueBrief("d1");
    expect(spy).toHaveBeenCalledTimes(3);
    let seen = 0;
    await q.consume(COLLECT_TOPIC, "g", "c", async () => { seen++; });
    expect(seen).toBe(1); // deduped
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    setJobQueue({ enqueue: async () => { throw new Error("redis down"); } } as never);
    await expect(enqueueCollect("d2")).resolves.toBeUndefined();
    await expect(enqueueBrief("d2")).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });
});
