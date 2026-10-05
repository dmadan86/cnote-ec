import { prisma } from "@cnote/db";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { iterateOpsLabels, type OpsLabelRow } from "../src";

const run = randomUUID();
const staffPerson = randomUUID();
const ghostPerson = randomUUID();
const rolesOf = async (ids: string[]) => new Map(ids.filter((i) => i === staffPerson).map((i) => [i, ["ops_moderator", "adjudicator"]]));
const collect = async (it: AsyncGenerator<OpsLabelRow>) => { const out: OpsLabelRow[] = []; for await (const r of it) out.push(r); return out; };
// a per-run capability keeps parallel test files from seeing each other's labels
const cap = `lbl_${run.slice(0, 8)}`;

async function seed(n: string, o: { status: "approved" | "rejected" | "open"; resolvedBy?: string | null; resolvedAt?: Date; input?: unknown; shadow?: boolean; reason?: string; capability?: string }) {
  const d = await prisma.aiDecision.create({
    data: {
      capability: o.capability ?? cap, provider: "anthropic", modelId: "claude-x", promptVersion: "moderate-v1", inputRedacted: (o.input ?? { text: "boxes" }) as never,
      output: { verdict: "review", reason: "call 9876543210" }, confidence: 0.4, latencyMs: 5, subjectType: "listing", subjectId: `${run}-${n}`, shadow: o.shadow ?? false,
    },
  });
  await prisma.reviewItem.create({
    data: {
      capability: o.capability ?? cap, subjectType: "listing", subjectId: `${run}-${n}`, reason: o.reason ?? "Low confidence 0.40", aiDecisionId: d.id, status: o.status,
      resolvedBy: o.resolvedBy ?? null, resolvedAt: o.status === "open" ? null : (o.resolvedAt ?? new Date()),
    },
  });
  return d.id;
}

afterAll(async () => {
  await prisma.reviewItem.deleteMany({ where: { subjectId: { startsWith: run } } });
  await prisma.aiDecision.deleteMany({ where: { subjectId: { startsWith: run } } });
});

describe("iterateOpsLabels", () => {
  it("exports resolved items with redacted data, roles instead of people, a day instead of a time, and no subject or person ids", async () => {
    const id = await seed("a", { status: "approved", resolvedBy: staffPerson, input: { text: "contact buyer@example.com or 9876543210, PAN ABCDE1234F" }, reason: "Flagged: ring 9876543210" });
    const rows = await collect(iterateOpsLabels({ capability: cap }, { rolesOf }));
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r).toMatchObject({ decisionId: id, label: "approved", labellerRoles: ["adjudicator", "ops_moderator"], modelId: "claude-x", promptVersion: "moderate-v1", subjectType: "listing" });
    expect(r.labelledOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/buyer@example\.com|9876543210|ABCDE1234F/);
    expect(json).not.toContain(staffPerson);
    expect(json).not.toContain(run); // subject id
    expect(Object.keys(r)).not.toContain("subjectId");
  });

  it("skips open items, shadow decisions and purged inputs; marks unknown labellers; filters by date and capability", async () => {
    const cap2 = `${cap}_b`;
    await seed("open", { status: "open", capability: cap2 });
    await seed("shadow", { status: "rejected", resolvedBy: staffPerson, shadow: true, capability: cap2 });
    await seed("purged", { status: "rejected", resolvedBy: staffPerson, input: { purged: true }, capability: cap2 });
    await seed("ghost", { status: "rejected", resolvedBy: ghostPerson, resolvedAt: new Date("2026-01-10T10:00:00Z"), capability: cap2 });
    await seed("late", { status: "approved", resolvedBy: staffPerson, resolvedAt: new Date("2026-03-10T10:00:00Z"), capability: cap2 });
    await seed("none", { status: "approved", resolvedBy: null, resolvedAt: new Date("2026-03-11T10:00:00Z"), capability: cap2 });

    const all = await collect(iterateOpsLabels({ capability: cap2 }, { rolesOf }));
    expect(all.map((r) => [r.label, r.labellerRoles.join()])).toEqual([["rejected", "unknown"], ["approved", "adjudicator,ops_moderator"], ["approved", "unknown"]]);

    const ranged = await collect(iterateOpsLabels({ capability: cap2, from: new Date("2026-02-01T00:00:00Z"), to: new Date("2026-03-11T00:00:00Z") }, { rolesOf }));
    expect(ranged).toHaveLength(1);
    expect(ranged[0]!.labelledOn).toBe("2026-03-10");
  });

  it("pages with a keyset cursor and honours maxRows", async () => {
    const cap3 = `${cap}_c`;
    const same = new Date("2026-05-05T05:05:05Z");
    for (let i = 0; i < 5; i++) await seed(`p${i}`, { status: i % 2 ? "approved" : "rejected", resolvedBy: staffPerson, resolvedAt: same, capability: cap3 });
    const paged = await collect(iterateOpsLabels({ capability: cap3 }, { rolesOf, pageSize: 2 }));
    expect(paged).toHaveLength(5);
    expect(new Set(paged.map((r) => r.decisionId)).size).toBe(5); // identical timestamps still page without gaps or repeats
    expect(await collect(iterateOpsLabels({ capability: cap3 }, { rolesOf, pageSize: 2, maxRows: 3 }))).toHaveLength(3);
  });
});
