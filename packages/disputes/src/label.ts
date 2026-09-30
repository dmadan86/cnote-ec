// ADR-013 -> ADR-008: every resolved dispute is a labelled example (brief recommendation vs final outcome) for the
// fraud classifiers and golden-set evals. Recorded as an AiDecision through @cnote/ai. Best effort: never blocks a resolution.
import { logDisputeOutcome } from "@cnote/ai";

export async function logOutcomeLabel(input: Parameters<typeof logDisputeOutcome>[0]): Promise<void> {
  try {
    await logDisputeOutcome(input);
  } catch (err) {
    console.error("[disputes] outcome label not recorded", err instanceof Error ? err.message : err);
  }
}
