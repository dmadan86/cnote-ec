import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { guardXlsx, listZip, parseImportFile, parseXlsxBytes, readZipEntries } from "../src/parse";
import { csv, GOOD } from "./fixtures";

const MB = 1024 * 1024;

/** Rewrites every local-header and central-directory "uncompressed size" field to `lie`: the archive still inflates to its real size. */
function lieAboutSizes(z: Uint8Array, lie = 10): Uint8Array {
  const out = z.slice();
  const dv = new DataView(out.buffer);
  for (let i = 0; i + 30 < out.length; i++) {
    if (dv.getUint32(i, true) === 0x04034b50) dv.setUint32(i + 22, lie, true);
    else if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, lie, true);
  }
  return out;
}
const zeros = (mb: number) => new Uint8Array(mb * MB);

describe("zip/xlsx bomb guard (security audit M9)", () => {
  it("a zip whose headers claim 10 bytes but inflates to 30 MB is judged on the real size", async () => {
    const z = lieAboutSizes(zipSync({ "products.csv": strToU8(csv(GOOD).toString()), "images/bomb.png": zeros(30) }, { level: 6 }));
    expect(z.length).toBeLessThan(200_000); // tiny on the wire
    // header-declared size would be 10 bytes (passes the 5 MB image cap); the actual 30 MB is rejected
    await expect(parseImportFile({ bytes: z, filename: "k.zip" })).rejects.toThrow(/larger than 5 MB/);
  });

  it("listZip enforces the total inflated-byte budget on actual bytes", () => {
    const z = lieAboutSizes(zipSync({ "a.bin": zeros(6), "b.bin": zeros(6) }));
    expect(() => listZip(z, { maxTotalBytes: 10 * MB })).toThrow(/expands to more than 10 MB/);
    expect(listZip(z, { maxTotalBytes: 20 * MB }).entries.map((e) => e.size)).toEqual([6 * MB, 6 * MB]); // real sizes, not the lie
  });

  it("lazy extraction stops at the per-image cap even when headers lie", () => {
    const z = lieAboutSizes(zipSync({ "images/a.png": zeros(8), "images/ok.png": new Uint8Array([1, 2, 3]) }));
    expect(() => readZipEntries(z, ["images/a.png"])).toThrow(/larger than 5 MB/);
    expect([...readZipEntries(z, ["images/ok.png"]).keys()]).toEqual(["images/ok.png"]); // unwanted entries are never inflated
  });

  it("an xlsx that inflates past the budget is rejected before ExcelJS loads it", async () => {
    const z = lieAboutSizes(zipSync({ "[Content_Types].xml": strToU8("<x/>"), "xl/workbook.xml": zeros(6) }));
    expect(() => guardXlsx(z, { maxTotalBytes: 5 * MB })).toThrow(/expands to more than 5 MB/);
    const big = lieAboutSizes(zipSync({ "xl/workbook.xml": zeros(201) }, { level: 1 }));
    await expect(parseXlsxBytes(big)).rejects.toThrow(/expands to more than 200 MB/);
  }, 60_000);

  it("caps xlsx entry count and declared sheet dimensions before reading cells", async () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 1001; i++) many[`xl/p${i}.xml`] = strToU8("x");
    await expect(parseXlsxBytes(zipSync(many))).rejects.toThrow(/too many parts/);
    const wide = zipSync({ "xl/worksheets/sheet1.xml": strToU8('<worksheet><dimension ref="A1:ZZ10"/></worksheet>') });
    await expect(parseXlsxBytes(wide)).rejects.toThrow(/too many columns/);
    const tall = zipSync({ "xl/worksheets/sheet1.xml": strToU8('<worksheet><dimension ref="A1:D1048576"/></worksheet>') });
    await expect(parseXlsxBytes(tall)).rejects.toThrow(/too many rows/);
  });
});
