import { randomUUID } from "node:crypto";
import type { MediaBucket, MediaHead, MediaObject, MediaStore } from "@cnote/media";
import { syntheticPng } from "../../ai/evals/fixtures";
import type { OrderContext, OrderContextPort, QualityActor } from "../src";

export class MemStore implements MediaStore {
  readonly driver = "mem";
  readonly bucket: MediaBucket = "private";
  objs = new Map<string, MediaObject>();
  async put(key: string, bytes: Uint8Array, contentType: string) { this.objs.set(key, { bytes, contentType }); }
  async get(key: string) { return this.objs.get(key) ?? null; }
  async delete(key: string) { this.objs.delete(key); }
  async exists(key: string) { return this.objs.has(key); }
  async head(key: string): Promise<MediaHead | null> { const o = this.objs.get(key); return o ? { size: o.bytes.length, contentType: o.contentType } : null; }
  async signedGetUrl() { return null; }
  publicUrl() { return null; }
}

export const photo = (n = 0) => syntheticPng(320 + n, 300, "checker", [200 - n, 30, 30]);
export const actor = (): QualityActor => ({ personId: randomUUID(), businessId: randomUUID() });

export function fakePort(over: Partial<OrderContext> = {}): OrderContextPort & { last: OrderContext } {
  const p = {
    last: undefined as unknown as OrderContext,
    async load(a: QualityActor, orderId: string) {
      p.last = {
        orderId, role: "seller", status: "confirmed", sellerBusinessId: a.businessId, categorySlug: "test-cat",
        spec: { productTitle: "3 ply box", quantity: 100, unit: "piece", requirement: "brown boxes, call 9876543210", attributes: { ply: 3, brand: "Acme" }, labelling: ["Brand or seller name"] },
        ...over,
      };
      return p.last;
    },
  };
  return p;
}
