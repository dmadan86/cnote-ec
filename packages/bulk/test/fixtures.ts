import type { CategoryView } from "@cnote/catalogue";
import { zipSync, strToU8 } from "fflate";
import { placeholderPng } from "../src/template";

export const CATS: CategoryView[] = [
  {
    id: "00000000-0000-4000-8000-000000000001", slug: "packaging-boxes", name: "Packaging boxes", icon: null, leadCap: 3, prohibited: false, parentId: null,
    attributeSchema: { fields: [
      { key: "gsm", label: "GSM", type: "number", unit: "g/m2", required: true },
      { key: "material", label: "Material", type: "select", options: ["Kraft", "Duplex", "White"] },
      { key: "color", label: "Colour", type: "text" },
    ] },
  },
  {
    id: "00000000-0000-4000-8000-000000000002", slug: "cotton-tshirts", name: "Cotton T-shirts", icon: null, leadCap: 3, prohibited: false, parentId: null,
    attributeSchema: { fields: [{ key: "gsm", label: "GSM", type: "number", unit: "g/m2" }, { key: "fabric", label: "Fabric", type: "select", options: ["Cotton", "Blend"] }] },
  },
  { id: "00000000-0000-4000-8000-000000000003", slug: "ms-pipes", name: "MS pipes", icon: null, leadCap: 3, prohibited: false, parentId: null, attributeSchema: { fields: [] } },
  { id: "00000000-0000-4000-8000-000000000009", slug: "weapons", name: "Weapons", icon: null, leadCap: 0, prohibited: true, parentId: null, attributeSchema: { fields: [] } },
];

export const HEADER = "sku*,title*,category*,description,price_rupees,price_unit,moq,moq_unit,hsn,language,image_files,image_urls,attr:gsm* (GSM),attr:material (Material)";
export const csv = (...lines: string[]) => Buffer.from([HEADER, ...lines].join("\n"), "utf8");
export const GOOD = "BOX-1,Corrugated box 12x9x6,packaging-boxes,Five ply corrugated box for shipping,18.50,piece,500,piece,48191010,en,,,300,Kraft";

export const zip = (files: Record<string, string | Uint8Array>) => zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v])));
export const png = () => new Uint8Array(placeholderPng());
