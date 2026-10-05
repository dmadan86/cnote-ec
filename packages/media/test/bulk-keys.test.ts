import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isValidMediaKey, mimeForKey } from "../src/keys";
import { LocalMediaStore } from "../src/store";

// Sellers' product sheets (prices, SKUs) share the storage port but must never be publicly addressable.
describe("bulk document keys", () => {
  const key = "bulk/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/source.zip";

  it("are valid in the private bucket only", () => {
    expect(isValidMediaKey(key)).toBe(true);
    expect(isValidMediaKey(key, "private")).toBe(true);
    expect(isValidMediaKey(key, "public")).toBe(false);
    expect(isValidMediaKey("bulk/../listings/x.csv", "private")).toBe(false);
  });

  it("map to document content types", () => {
    expect(mimeForKey("bulk/a/products.csv")).toBe("text/csv");
    expect(mimeForKey("bulk/a/products.xlsx")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(mimeForKey(key)).toBe("application/zip");
  });

  let dir: string;
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("round-trip through the local private store and are refused by the public one", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "media-bulk-"));
    const priv = new LocalMediaStore(dir, "private");
    const bytes = new TextEncoder().encode("sku,title\nA,B\n");
    await priv.put("bulk/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/products.csv", bytes, "text/csv");
    const got = await priv.get("bulk/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/products.csv");
    expect(new TextDecoder().decode(got!.bytes)).toBe("sku,title\nA,B\n");
    expect(got!.contentType).toBe("text/csv");

    const pub = new LocalMediaStore(dir, "public");
    await expect(pub.put("bulk/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/products.csv", bytes, "text/csv")).rejects.toThrow("Invalid media key");
    expect(() => pub.publicUrl("bulk/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/products.csv")).toThrow("Invalid media key");
  });
});

describe("voice note keys", () => {
  it("are private-only and map to audio types", () => {
    const k = "listings/_voice/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10.ogg";
    expect(isValidMediaKey(k, "private")).toBe(true);
    expect(isValidMediaKey(k, "public")).toBe(false);
    expect(mimeForKey(k)).toBe("audio/ogg");
    expect(mimeForKey("listings/_voice/a.m4a")).toBe("audio/mp4");
  });
});

describe("invoice and KYC keys", () => {
  it("are private-only; invoices map to application/pdf", () => {
    for (const k of ["invoices/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10.pdf", "kyc/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/pan.jpg", "disputes/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/e1.jpg", "quality/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/p1.jpg", "rfq/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/a1.pdf", "grn/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/p1.jpg"]) {
      expect(isValidMediaKey(k, "private")).toBe(true);
      expect(isValidMediaKey(k, "public")).toBe(false);
    }
    expect(mimeForKey("invoices/a.pdf")).toBe("application/pdf");
  });
});
