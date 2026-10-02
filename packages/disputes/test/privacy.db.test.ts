import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportPersonalData } from "../src";

describe("exportPersonalData (DPDP access right)", () => {
  it("returns every collection (empty for a person with no disputes), with and without business context", async () => {
    for (const businessIds of [[], [randomUUID()]]) {
      const out = (await exportPersonalData(randomUUID(), { businessIds })) as Record<string, { items: unknown[]; truncated: boolean }>;
      for (const k of ["disputes", "disputeEvidence", "disputeMessages", "disputeAppeals"]) expect(out[k], k).toEqual({ items: [], truncated: false });
    }
  });
});
