import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportPersonalData } from "../src";

const personId = randomUUID();
let made = false;
afterAll(async () => {
  if (made) {
    await prisma.notification.deleteMany({ where: { personId } });
    await prisma.notificationPreference.deleteMany({ where: { personId } });
    await prisma.person.deleteMany({ where: { id: personId } });
  }
});

describe("exportPersonalData (DPDP access right)", () => {
  it("exports notifications and channel preferences", async () => {
    await prisma.person.create({ data: { id: personId, email: `nt-${personId}@example.test` } });
    made = true;
    await prisma.notification.create({ data: { personId, kind: "lead.matched", title: "New lead", body: "Body", href: "/leads", app: "seller" } });
    const out = (await exportPersonalData(personId)) as { notifications: { items: any[] }; notificationPreferences: unknown[] };
    expect(out.notifications.items).toHaveLength(1);
    expect(out.notifications.items[0]).toMatchObject({ kind: "lead.matched", title: "New lead", app: "seller" });
    expect(out.notificationPreferences).toEqual([]);
  });
  it("is empty for an unknown person", async () => {
    expect(await exportPersonalData(randomUUID())).toEqual({ notifications: { items: [], truncated: false }, notificationPreferences: [] });
  });
});
