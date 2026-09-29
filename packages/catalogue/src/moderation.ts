import * as ai from "@cnote/ai";
import { canonicalText } from "./validate";
import type { CategoryView } from "./index";

export type Assessment =
  | { outcome: "rejected"; reason: string }
  | { outcome: "approved" | "review"; reason: string | null; embedding: number[]; embeddingVersion: string };

interface Content {
  id: string;
  title: string;
  description: string;
  attributes: Record<string, string | number>;
}

/**
 * Moderation + embedding for a listing about to be (or already) published (ADR-003, ADR-004).
 * Prohibited categories are rejected without calling the model. A confident "allow" that the AI layer
 * flagged needsReview is downgraded to human review (ADR-008: low confidence → ops queue).
 */
export async function assess(l: Content, category: CategoryView): Promise<Assessment> {
  if (category.prohibited) return { outcome: "rejected", reason: `Category "${category.name}" is not permitted on the marketplace` };
  const text = canonicalText(l, category.name);
  const mod = await ai.moderate({ text, categorySlug: category.slug }, { type: "listing", id: l.id });
  if (mod.verdict === "block") return { outcome: "rejected", reason: mod.reason ?? `Blocked by content policy${mod.flags.length ? `: ${mod.flags.join(", ")}` : ""}` };
  const { vectors, version } = await ai.embed([text]);
  const embedding = vectors[0];
  if (!embedding) throw new Error("embedding provider returned no vector");
  const review = mod.verdict === "review" || mod.needsReview;
  return { outcome: review ? "review" : "approved", reason: review ? (mod.reason ?? "Flagged for manual review") : null, embedding, embeddingVersion: version };
}
