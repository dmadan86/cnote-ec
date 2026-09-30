// Work-queue topics (typed via declaration merging) and safe enqueue helpers.
import { getJobQueue } from "@cnote/core";

export const COLLECT_TOPIC = "disputes.collect" as const;
export const BRIEF_TOPIC = "disputes.brief" as const;

declare module "@cnote/core" {
  interface JobTopics {
    "disputes.collect": { disputeId: string };
    "disputes.brief": { disputeId: string };
  }
}

/** Enqueue failures never fail the user's action: the advance job re-enqueues anything that stalled. */
export async function enqueueCollect(disputeId: string, bucket = ""): Promise<void> {
  try {
    await getJobQueue().enqueue(COLLECT_TOPIC, { disputeId }, { dedupeKey: `collect:${disputeId}${bucket}` });
  } catch (err) {
    console.error("[disputes] enqueue collect failed", err instanceof Error ? err.message : err);
  }
}
export async function enqueueBrief(disputeId: string, bucket = ""): Promise<void> {
  try {
    await getJobQueue().enqueue(BRIEF_TOPIC, { disputeId }, { dedupeKey: `brief:${disputeId}${bucket}`, maxAttempts: 5 });
  } catch (err) {
    console.error("[disputes] enqueue brief failed", err instanceof Error ? err.message : err);
  }
}
