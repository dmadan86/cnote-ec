import { EMBEDDING_DIM } from "@cnote/db";
import { describe, expect, it } from "vitest";
import { cosine, embed, embedText } from "../src";

describe("local embedder hash-v1", () => {
  it("is deterministic, EMBEDDING_DIM wide and L2-normalised", async () => {
    const { vectors, version } = await embed(["Corrugated box 5 ply", "Corrugated box 5 ply", ""]);
    expect(version).toBe("hash-v1");
    expect(vectors[0]).toHaveLength(EMBEDDING_DIM);
    expect(vectors[0]).toEqual(vectors[1]);
    for (const v of vectors) expect(Math.hypot(...v)).toBeCloseTo(1, 6); // empty text still yields a unit vector
  });
  it("scores similar and cross-language texts above unrelated ones", () => {
    const a = embedText("500 pcs corrugated box 5 ply");
    expect(cosine(a, embedText("gatta dabba 5 ply 500 pieces"))).toBeGreaterThan(0.6);
    expect(cosine(a, embedText("cotton fabric 150 gsm"))).toBeLessThan(0.3);
    expect(cosine(embedText("500 pcs"), embedText("500 pieces"))).toBeGreaterThan(0.9);
  });
});
