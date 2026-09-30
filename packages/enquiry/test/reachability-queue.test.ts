import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { afterAll, describe, expect, it, vi } from "vitest";

// Production path: the request process only QUEUES delivery; the worker (which registers the notifier) delivers.
const dispatched = vi.hoisted(() => [] as string[]);

const reach = await import("../src/reachability");
const { worker } = await import("../src/worker");

describe("reachability dispatch via the job queue", () => {
  const q = new MemoryJobQueue();
  setJobQueue(q);
  afterAll(() => setJobQueue(undefined));

  it("enqueues once per check (deduped) and the worker consumer delivers", async () => {
    reach.setReachabilityDispatchMode("queue");
    const spy = vi.spyOn(reach, "handleDispatchJob").mockImplementation(async (id) => void dispatched.push(id));
    await reach.enqueueDispatch("c1");
    await reach.enqueueDispatch("c1"); // dedupe key: a retried report doesn't ping the buyer twice
    const consumer = worker.queues!.find((c) => c.topic === reach.REACHABILITY_DISPATCH_TOPIC)!;
    expect(consumer).toBeTruthy();
    const n = await q.consume(reach.REACHABILITY_DISPATCH_TOPIC, "enquiry", "t", async (m) => {
      await reach.handleDispatchJob((m.payload as { checkId: string }).checkId);
    });
    expect(n).toBe(1);
    expect(dispatched).toEqual(["c1"]);
    spy.mockRestore();
  });
});
