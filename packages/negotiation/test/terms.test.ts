import { describe, expect, it } from "vitest";
import { hasStructuredTerms, mapPaymentTerms, mapShippingTerms, structuredComparisonTerms } from "../src";

const none = { deliveryTerms: null, deliveryChargePaise: null, paymentTerms: null, gstIncluded: null } as const;

describe("structured quote terms", () => {
  it("detects whether any structured term is present", () => {
    expect(hasStructuredTerms(none)).toBe(false);
    expect(hasStructuredTerms({ ...none, gstIncluded: false })).toBe(true);
    expect(hasStructuredTerms({ ...none, paymentTerms: "net_30" })).toBe(true);
    expect(hasStructuredTerms({ ...none, deliveryTerms: "fob" })).toBe(true);
    expect(hasStructuredTerms({ ...none, deliveryChargePaise: 0 })).toBe(true);
  });

  it("maps them to comparison inputs without guessing", () => {
    expect(structuredComparisonTerms({ ...none, deliveryChargePaise: 250000 })).toMatchObject({ deliveryChargePaise: 250000, deliveryIncluded: false });
    expect(structuredComparisonTerms({ ...none, deliveryChargePaise: 0 })).toMatchObject({ deliveryChargePaise: 0, deliveryIncluded: true });
    expect(structuredComparisonTerms({ ...none, deliveryTerms: "buyer_pickup" })).toMatchObject({ deliveryChargePaise: 0, deliveryIncluded: true });
    expect(structuredComparisonTerms({ ...none, deliveryTerms: "ex_works" }).deliveryChargePaise).toBe(0);
    // door delivery without a stated charge stays unknown
    expect(structuredComparisonTerms({ ...none, deliveryTerms: "door_delivery" })).toMatchObject({ deliveryChargePaise: null, deliveryIncluded: null });
    expect(structuredComparisonTerms({ ...none, paymentTerms: "advance", gstIncluded: true })).toMatchObject({ paymentTerms: "advance", gstIncluded: true });
  });

  it("maps free-text shipping terms to the delivery enum", () => {
    expect(mapShippingTerms(null)).toEqual({ deliveryTerms: null, deliveryNote: null });
    expect(mapShippingTerms("  ")).toEqual({ deliveryTerms: null, deliveryNote: null });
    expect(mapShippingTerms("Ex-works Pune").deliveryTerms).toBe("ex_works");
    expect(mapShippingTerms("FOB Mumbai port").deliveryTerms).toBe("fob");
    expect(mapShippingTerms("Buyer pickup from godown").deliveryTerms).toBe("buyer_pickup");
    expect(mapShippingTerms("Free delivery to your door").deliveryTerms).toBe("door_delivery");
    expect(mapShippingTerms("Freight extra")).toEqual({ deliveryTerms: "other", deliveryNote: "Freight extra" });
    expect(mapShippingTerms("x".repeat(500)).deliveryNote).toHaveLength(300);
  });

  it("maps free-text payment terms to the payment enum", () => {
    expect(mapPaymentTerms("")).toEqual({ paymentTerms: null, paymentNote: null });
    expect(mapPaymentTerms("Net 30 days").paymentTerms).toBe("net_30");
    expect(mapPaymentTerms("net_15").paymentTerms).toBe("net_15");
    expect(mapPaymentTerms("within 7 days").paymentTerms).toBe("net_7");
    expect(mapPaymentTerms("100% advance").paymentTerms).toBe("advance");
    expect(mapPaymentTerms("Cash on delivery").paymentTerms).toBe("on_delivery");
    expect(mapPaymentTerms("via escrow").paymentTerms).toBe("escrow");
    expect(mapPaymentTerms("50% now, rest later")).toEqual({ paymentTerms: "other", paymentNote: "50% now, rest later" });
  });
  it("accepts exact delivery enum codes", () => {
    expect(mapShippingTerms("ex_works").deliveryTerms).toBe("ex_works");
    expect(mapShippingTerms("buyer_pickup").deliveryTerms).toBe("buyer_pickup");
    expect(mapShippingTerms("door_delivery").deliveryTerms).toBe("door_delivery");
  });
});
