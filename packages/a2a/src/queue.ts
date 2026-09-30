import { getJobQueue } from "@cnote/core";

export const ADVANCE_TOPIC = "a2a.advance";
declare module "@cnote/core" {
  interface JobTopics {
    "a2a.advance": { negotiationId: string };
    "a2a.finalise": { negotiationId: string };
  }
}
export const FINALISE_TOPIC = "a2a.finalise";

/** Best-effort: the scheduled sweep (worker) recovers any negotiation whose job was lost, so a queue hiccup never strands a negotiation. */
export async function scheduleAdvance(negotiationId: string, round: number): Promise<void> {
  try {
    await getJobQueue().enqueue(ADVANCE_TOPIC, { negotiationId }, { dedupeKey: `advance:${negotiationId}:${round}` });
  } catch {
    /* sweep will pick it up */
  }
}
export async function scheduleFinalise(negotiationId: string): Promise<void> {
  try {
    await getJobQueue().enqueue(FINALISE_TOPIC, { negotiationId }, { dedupeKey: `finalise:${negotiationId}:${Date.now() >> 12}` });
  } catch {
    /* retried by confirm/retry */
  }
}
