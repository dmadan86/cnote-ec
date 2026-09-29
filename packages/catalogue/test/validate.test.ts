import { describe, expect, it } from "vitest";
import { canonicalText, coerceAttributes, validateAttributes, validatePublishable } from "../src/validate";

const schema = {
  fields: [
    { key: "gsm", label: "GSM", type: "number" as const, required: true },
    { key: "fabric", label: "Fabric", type: "select" as const, options: ["Cotton", "Polyester"] },
    { key: "note", label: "Note", type: "text" as const },
  ],
};

describe("validateAttributes", () => {
  it("flags missing required fields", () => expect(validateAttributes(schema, {})).toEqual(["GSM is required"]));
  it("rejects non-numeric numbers and bad select options", () => {
    expect(validateAttributes(schema, { gsm: "abc", fabric: "Silk" })).toHaveLength(2);
  });
  it("accepts valid input", () => expect(validateAttributes(schema, { gsm: 180, fabric: "Cotton" })).toEqual([]));
});

describe("coerceAttributes", () => {
  it("coerces numeric strings and canonicalises select case", () => {
    expect(coerceAttributes(schema, { gsm: "180", fabric: "cotton" })).toEqual({ gsm: 180, fabric: "Cotton" });
  });
});

describe("publish rules", () => {
  it("requires a real title and description", () => {
    expect(validatePublishable({ title: "ab", description: "short" })).toHaveLength(2);
    expect(validatePublishable({ title: "Cotton tee", description: "Round neck cotton tee 180 gsm" })).toEqual([]);
  });
  it("canonical text carries title, category, attributes, description", () => {
    const t = canonicalText({ title: "Tee", description: "Soft", attributes: { gsm: 180 } }, "Apparel");
    expect(t).toBe("Tee\nApparel\ngsm: 180\nSoft");
  });
});
