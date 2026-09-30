import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalMediaStore, setMediaStore } from "@cnote/media";
import { afterAll, describe, expect, it } from "vitest";
import { mediaInvoiceDocStore } from "../src/invoices";

// Default invoice document store: the PRIVATE media bucket (invoices/ keys are private-only in @cnote/media).
describe("mediaInvoiceDocStore", () => {
  let dir: string;
  afterAll(async () => {
    setMediaStore(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a PDF through the private media store and misses cleanly", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "inv-"));
    setMediaStore(new LocalMediaStore(dir, "private"), "private");
    const key = "invoices/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d10/document.pdf";
    const pdf = new TextEncoder().encode("%PDF-1.7 test");
    await mediaInvoiceDocStore.put(key, pdf);
    expect(new TextDecoder().decode((await mediaInvoiceDocStore.get(key))!)).toBe("%PDF-1.7 test");
    expect(await mediaInvoiceDocStore.get("invoices/0b6b1f0e-5f1a-4c55-9a35-3c1a4b0a9d11/document.pdf")).toBeNull();
  });
});
