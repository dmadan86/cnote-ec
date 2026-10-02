import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportAlertsData, exportPersonalData } from "../src";

describe("exportPersonalData (registry-shaped alias of exportAlertsData)", () => {
  it("returns the same document", async () => {
    const p = randomUUID();
    expect(await exportPersonalData(p)).toEqual(await exportAlertsData(p));
    expect(await exportPersonalData(p)).toEqual({ followedSuppliers: [], savedSearches: [], alertSettings: null });
  });
});
