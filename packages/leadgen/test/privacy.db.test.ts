import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportPersonalData } from "../src";

const personId = randomUUID();
let made = false;
afterAll(async () => {
  if (made) {
    await prisma.leadCapture.deleteMany({ where: { personId } });
    await prisma.person.deleteMany({ where: { id: personId } });
  }
});

describe("exportPersonalData (DPDP access right)", () => {
  it("exports the person's capture rows without the phone hash or visitor id", async () => {
    await prisma.person.create({ data: { id: personId, email: `lg-${personId}@example.test` } });
    made = true;
    await prisma.leadCapture.create({ data: { visitorId: `v-${personId}`, personId, phoneHash: "h".repeat(64), trigger: "request_quote", unlock: "enquiry", followUpConsent: true } });
    const out = (await exportPersonalData(personId)) as { leadCaptures: { items: any[] } };
    expect(out.leadCaptures.items).toHaveLength(1);
    expect(out.leadCaptures.items[0]).toMatchObject({ trigger: "request_quote", unlock: "enquiry", followUpConsent: true });
    expect(JSON.stringify(out)).not.toContain("hhhhhhhh");
    expect(JSON.stringify(out)).not.toContain(`v-${personId}`);
  });
  it("is empty for an unknown person", async () => {
    expect(await exportPersonalData(randomUUID())).toEqual({ leadCaptures: { items: [], truncated: false } });
  });
});
