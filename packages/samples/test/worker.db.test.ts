import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@cnote/db";
import { photoStore, setSamplePhotoStore } from "../src/ports";
import { runExpiryJob } from "../src/sla";
import { worker } from "../src";
import { Fixtures, SHIP } from "./helpers";

const fx = new Fixtures();
afterAll(async () => { await fx.cleanup(); delete process.env.SAMPLES_ENABLED; });
beforeAll(() => { process.env.SAMPLES_ENABLED = "true"; });

describe("samples worker", () => {
  it("registers the SLA sweep and the retention purge, and handles erasure requests", async () => {
    expect(worker.name).toBe("samples");
    expect(worker.jobs!.map((j) => j.name)).toEqual(["samples.expire-overdue", "samples.purge-personal-data"]);
    const d = await fx.deal();
    const row = await prisma.sampleRequest.create({
      data: {
        buyerBusinessId: d.buyer.businessId, buyerPersonId: d.buyer.personId, sellerBusinessId: d.seller.businessId, subject: "x", quantity: 1,
        shipName: SHIP.name, shipLine1: SHIP.line1, shipCity: SHIP.city, shipPincode: SHIP.pincode, respondBy: new Date(Date.now() + 3_600_000),
      },
    });
    fx.track(row.id);
    await worker.handlers!.DataErasureRequested!({ id: 1, type: "DataErasureRequested", version: 1, aggregateType: "p", aggregateId: "p", occurredAt: "", payload: { personId: d.buyer.personId } } as never);
    expect((await prisma.sampleRequest.findUniqueOrThrow({ where: { id: row.id } })).shipLine1).toBeNull();
    for (const j of worker.jobs!) await j.run();
  });

  it("the expiry job does nothing while the flag is off", async () => {
    const d = await fx.deal();
    const row = await prisma.sampleRequest.create({
      data: { buyerBusinessId: d.buyer.businessId, buyerPersonId: d.buyer.personId, sellerBusinessId: d.seller.businessId, subject: "x", quantity: 1, respondBy: new Date(Date.now() - 1000), activeKey: `k:${fx.tag}` },
    });
    fx.track(row.id);
    process.env.SAMPLES_ENABLED = "false";
    try { await runExpiryJob(); } finally { process.env.SAMPLES_ENABLED = "true"; }
    expect((await prisma.sampleRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("requested");
    await runExpiryJob();
    expect((await prisma.sampleRequest.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("expired");
  });

  it("the default photo store is the private bucket (put, get, delete round trip)", async () => {
    setSamplePhotoStore(null);
    const key = `samples/${fx.tag}/p1.jpg`;
    await photoStore().put(key, new Uint8Array([0xff, 0xd8, 0xff, 1]), "image/jpeg");
    expect((await photoStore().get(key))!.contentType).toBe("image/jpeg");
    await photoStore().delete(key);
    expect(await photoStore().get(key)).toBeNull();
  });
});
