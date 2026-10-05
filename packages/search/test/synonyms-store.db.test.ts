// Versioned synonym dictionary: DB-backed (isolated cnote_test).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@cnote/db";
import {
  activeSynonymLines, activeSynonymsOrEmpty, getActiveSynonyms, getSynonymVersion, importBuiltInSynonyms, invalidateSynonymCache, listSynonymVersions, publishSynonyms, rollbackSynonyms,
  SYNONYM_CACHE_MS,
} from "../src/synonyms/store";

const staff = randomUUID();
const wipe = () => prisma.searchSynonymVersion.deleteMany({});

beforeAll(wipe);
beforeEach(async () => {
  await wipe();
  invalidateSynonymCache();
});
afterAll(async () => {
  await wipe();
  invalidateSynonymCache();
});

describe("synonym versions", () => {
  it("starts empty at version 0", async () => {
    expect(await getActiveSynonyms()).toEqual({ version: 0, groups: [] });
    expect(await listSynonymVersions()).toEqual([]);
  });

  it("publishing appends version N+1 and makes it active at once (local cache invalidated)", async () => {
    await getActiveSynonyms(); // warm the cache with the empty set
    const v1 = await publishSynonyms([{ terms: ["Kapda", "cloth"] }], { staffId: staff, note: "first" });
    expect(v1.version).toBe(1);
    expect((await getActiveSynonyms()).groups).toEqual([{ terms: ["kapda", "cloth"] }]);
    const v2 = await publishSynonyms([{ terms: ["kapda", "cloth"] }, { terms: ["dabba", "box"] }], { staffId: staff, editedFrom: 1 });
    expect(v2.version).toBe(2);
    const list = await listSynonymVersions();
    expect(list.map((v) => [v.version, v.groupCount, v.source, v.basedOnVersion])).toEqual([[2, 2, "edit", 1], [1, 1, "edit", null]]);
    expect(list[1]).toMatchObject({ note: "first", createdByStaffId: staff });
    expect(list[0]).not.toHaveProperty("groups"); // the list is a summary
  });

  it("refuses to publish over a version the editor never saw (lost-update guard)", async () => {
    await publishSynonyms([{ terms: ["a", "b"] }], { staffId: staff });
    await publishSynonyms([{ terms: ["a", "c"] }], { staffId: staff });
    await expect(publishSynonyms([{ terms: ["x", "y"] }], { staffId: staff, editedFrom: 1 })).rejects.toMatchObject({ code: "conflict" });
    expect((await getActiveSynonyms()).version).toBe(2);
  });

  it("validates before storing: nothing is written for a bad dictionary", async () => {
    await expect(publishSynonyms([{ terms: ["alone"] }], { staffId: staff })).rejects.toMatchObject({ code: "validation" });
    expect(await prisma.searchSynonymVersion.count()).toBe(0);
  });

  it("rollback publishes a COPY of an older snapshot as the newest version; history is untouched", async () => {
    await publishSynonyms([{ terms: ["a", "b"] }], { staffId: staff });
    await publishSynonyms([{ terms: ["c", "d"] }], { staffId: staff });
    const r = await rollbackSynonyms(1, { staffId: staff });
    expect(r.version).toBe(3);
    expect(r.groups).toEqual([{ terms: ["a", "b"] }]);
    expect((await getSynonymVersion(2))!.groups).toEqual([{ terms: ["c", "d"] }]);
    const top = (await listSynonymVersions())[0]!;
    expect(top).toMatchObject({ version: 3, source: "rollback", basedOnVersion: 1 });
    await expect(rollbackSynonyms(99, { staffId: staff })).rejects.toMatchObject({ code: "not_found" });
    expect(await getSynonymVersion(99)).toBeNull();
  });

  it("serves the cached set for SYNONYM_CACHE_MS, then re-reads (other instances converge)", async () => {
    const t0 = Date.now();
    await getActiveSynonyms(t0);
    await prisma.searchSynonymVersion.create({ data: { version: 1, groups: [{ terms: ["x", "y"] }], groupCount: 1, source: "edit" } }); // written behind this process's back
    expect((await getActiveSynonyms(t0 + 1000)).version).toBe(0);
    expect((await getActiveSynonyms(t0 + SYNONYM_CACHE_MS + 1)).version).toBe(1);
  });

  it("re-validates stored JSON on read, so a hand-edited row cannot break search", async () => {
    await prisma.searchSynonymVersion.create({ data: { version: 1, groups: [{ terms: ["ok", "fine"] }, { terms: ["lonely"] }, "garbage"], groupCount: 3, source: "edit" } });
    expect((await getActiveSynonyms()).groups).toEqual([{ terms: ["ok", "fine"] }]);
  });

  it("imports the shipped starter dictionary, merged with what is there", async () => {
    await publishSynonyms([{ terms: ["mine", "yours"] }], { staffId: staff });
    const r = await importBuiltInSynonyms({ staffId: staff });
    expect(r.version).toBe(2);
    expect(r.groups[0]).toEqual({ terms: ["mine", "yours"] });
    expect(r.groups.some((g) => g.terms.includes("कपड़ा"))).toBe(true);
    expect((await listSynonymVersions())[0]).toMatchObject({ source: "import" });
    // importing twice adds nothing new (identical groups are merged)
    expect((await importBuiltInSynonyms({ staffId: staff })).groups).toHaveLength(r.groups.length);
    expect((await importBuiltInSynonyms({ staffId: null })).version).toBe(4);
    expect((await listSynonymVersions())[0]).toMatchObject({ source: "seed" });
  });

  it("renders OpenSearch synonym lines", async () => {
    await publishSynonyms([{ terms: ["kapda", "कपड़ा", "cloth"] }], { staffId: staff });
    expect(await activeSynonymLines()).toEqual(["kapda, कपड़ा, cloth"]);
  });

  it("retries on a version-number race", async () => {
    const real = prisma.searchSynonymVersion.create.bind(prisma.searchSynonymVersion);
    const spy = vi.spyOn(prisma.searchSynonymVersion, "create").mockImplementationOnce((async () => {
      await real({ data: { version: 1, groups: [{ terms: ["racer", "winner"] }], groupCount: 1, source: "edit" } }); // the competing publish
      throw Object.assign(new Error("unique"), { code: "P2002" });
    }) as never);
    const r = await publishSynonyms([{ terms: ["mine", "ours"] }], { staffId: staff });
    expect(r.version).toBe(2);
    spy.mockRestore();
  });
});

describe("hot-path accessor", () => {
  it("degrades to an empty dictionary when the read fails and does not cache the failure", async () => {
    const spy = vi.spyOn(prisma.searchSynonymVersion, "findFirst").mockRejectedValueOnce(new Error("db down"));
    expect(await activeSynonymsOrEmpty()).toEqual({ version: 0, groups: [] });
    spy.mockRestore();
    await prisma.searchSynonymVersion.create({ data: { version: 1, groups: [{ terms: ["x", "y"] }], groupCount: 1, source: "edit" } });
    expect((await activeSynonymsOrEmpty()).version).toBe(1);
  });
});
