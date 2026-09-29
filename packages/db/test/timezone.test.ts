import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src";

// Regression: the pg driver adapter sends timestamps without an offset, so a non-UTC session
// TimeZone (e.g. Asia/Kolkata) silently shifted every stored instant. The client pins UTC.
describe("timestamps", () => {
  afterAll(() => prisma.$disconnect());

  it("session runs in UTC", async () => {
    const rows = await prisma.$queryRaw<{ tz: string }[]>`select current_setting('TimeZone') as tz`;
    expect(rows[0]?.tz).toBe("UTC");
  });

  it("round-trips instants exactly", async () => {
    const d = new Date("2026-01-15T10:00:00.000Z");
    const row = await prisma.domainEvent.create({ data: { type: "TzCheck", aggregateType: "tz", aggregateId: crypto.randomUUID(), payload: {}, occurredAt: d } });
    try {
      const back = await prisma.domainEvent.findUniqueOrThrow({ where: { id: row.id } });
      expect(back.occurredAt.toISOString()).toBe(d.toISOString());
    } finally {
      await prisma.domainEvent.delete({ where: { id: row.id } });
    }
  });
});
