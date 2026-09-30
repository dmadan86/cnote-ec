import type { ChecklistItem, ExpectedSpec } from "./types";

const clean = (s: string, max = 500) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** Checklist shown to the seller: what the photos should let a reviewer confirm, derived from the order/listing. */
export function buildChecklist(spec: ExpectedSpec): ChecklistItem[] {
  const attrs = Object.entries(spec.attributes).map(([k, v]) => `${k}: ${v}`).join(", ");
  return [
    { check: "quantity", label: "Show all units so they can be counted", expected: spec.quantity != null ? `${spec.quantity}${spec.unit ? ` ${spec.unit}` : ""}` : "Quantity not recorded on the order" },
    { check: "labelling", label: "Show labels and markings clearly", expected: spec.labelling.length ? spec.labelling.join(", ") : "No specific marking required" },
    { check: "spec", label: "Show the product as ordered", expected: attrs || clean(spec.requirement, 200) || spec.productTitle },
  ];
}

const GENERIC_LABELLING = ["Brand or seller name", "Product name or size marking"];
const LABEL_ATTR_KEYS = /^(brand|batch|grade|size|hsn|mrp|model)$/i;

/** Normalises what the port returned into a bounded, JSON-safe expectation snapshot. */
export function buildExpectedSpec(input: { title: string; quantity: number | null; unit: string | null; requirement: string; attributes?: Record<string, string | number> }): ExpectedSpec {
  const attributes: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(input.attributes ?? {}).slice(0, 20)) attributes[clean(k, 40)] = typeof v === "number" ? v : clean(String(v), 80);
  const fromAttrs = Object.keys(attributes).filter((k) => LABEL_ATTR_KEYS.test(k)).map((k) => `${k} ${attributes[k]}`);
  return {
    productTitle: clean(input.title, 200), quantity: input.quantity, unit: input.unit, requirement: clean(input.requirement),
    attributes, labelling: [...GENERIC_LABELLING, ...fromAttrs],
  };
}
