// DPDP export: delivery addresses and KYC sessions are listed with masked document fields (no PAN ciphertext, no images).
import { randomUUID } from "node:crypto";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { exportPersonalData, verifyErasureStepUp } from "../src";

const bizIds: string[] = [];
const personIds: string[] = [];
afterAll(async () => {
  await prisma.kycSession.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessAddress.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.businessMember.deleteMany({ where: { businessId: { in: bizIds } } });
  await prisma.business.deleteMany({ where: { id: { in: bizIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
});

describe("exportPersonalData", () => {
  it("includes addresses and KYC sessions without the encrypted PAN", async () => {
    const person = await prisma.person.create({ data: { email: `exp-${randomUUID()}@example.test`, name: "Exporter" } });
    personIds.push(person.id);
    const biz = await prisma.business.create({ data: { name: `Export ${randomUUID().slice(0, 6)}` } });
    bizIds.push(biz.id);
    await prisma.businessMember.create({ data: { businessId: biz.id, personId: person.id, role: "owner" } });
    await prisma.businessAddress.create({ data: { businessId: biz.id, label: "Warehouse", line1: "Plot 9", city: "Pune", state: "Maharashtra", stateCode: "27", pincode: "411019", isDefault: true } });
    const sess = await prisma.kycSession.create({ data: { businessId: biz.id, personId: person.id, provider: "mock", expiresAt: new Date(Date.now() + 86_400_000) } });
    await prisma.kycDocument.createMany({
      data: [
        { sessionId: sess.id, docType: "pan_card", sha256: randomUUID(), storageKey: "kyc/x.jpg", extracted: { pan: "XXXXX1234F", panEnc: "v1.secret" } },
        { sessionId: sess.id, docType: "bank_proof", sha256: randomUUID(), storageKey: null, extracted: { account: "XXXX1234" } },
      ],
    });
    const out = (await exportPersonalData(person.id)) as {
      deliveryAddresses: { label: string; pincode: string }[];
      kycSessions: { id: string; documents: { docType: string; extracted: Record<string, unknown>; imageRetained: boolean }[] }[];
    };
    expect(out.deliveryAddresses).toEqual([expect.objectContaining({ label: "Warehouse", pincode: "411019" })]);
    const docs = out.kycSessions.find((k) => k.id === sess.id)!.documents;
    expect(docs.find((d) => d.docType === "pan_card")).toMatchObject({ extracted: { pan: "XXXXX1234F" }, imageRetained: true });
    expect(JSON.stringify(out)).not.toContain("v1.secret");
    expect(docs.find((d) => d.docType === "bank_proof")?.imageRetained).toBe(false);
  });

  it("erasure step-up refuses unknown and already-erased accounts", async () => {
    await expect(verifyErasureStepUp(randomUUID(), { password: "whatever-123" })).rejects.toMatchObject({ code: "not_found" });
    const gone = await prisma.person.create({ data: { email: `gone-${randomUUID()}@example.test`, erasedAt: new Date() } });
    personIds.push(gone.id);
    await expect(verifyErasureStepUp(gone.id, { password: "whatever-123" })).rejects.toMatchObject({ code: "not_found" });
  });
});
