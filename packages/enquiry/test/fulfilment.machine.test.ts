import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FULFILMENT_STAGES, applyFulfilment, availableFulfilmentStages, type FulfilmentStage, type FulfilmentState } from "../src/fulfilment";
import { availableActions } from "../src/orders";

type Status = FulfilmentState["status"];
const STATUSES: Status[] = ["recorded", "confirmed", "dispatched", "delivered", "completed", "cancelled"];
const STAGES = [...FULFILMENT_STAGES];
const stageArb = fc.constantFrom(...STAGES);
const statusArb = fc.constantFrom(...STATUSES);
const st = (status: Status, fulfilmentStage: FulfilmentStage | null = null): FulfilmentState => ({ status, fulfilmentStage });

// The specification, written independently of FULFILMENT_RULES.
const specOk = (status: Status, stage: FulfilmentStage) => (stage === "packed" ? status === "confirmed" : status === "dispatched");

describe("fulfilment stage machine", () => {
  it("has the documented forward order", () => {
    expect(STAGES).toEqual(["packed", "in_transit", "out_for_delivery", "delivery_attempted"]);
  });

  for (const status of STATUSES) for (const stage of STAGES) {
    it(`seller: ${status} + ${stage} is ${specOk(status, stage) ? "allowed" : "rejected"} from a clean order`, () => {
      if (specOk(status, stage)) expect(applyFulfilment(st(status), "seller", stage)).toEqual({ changed: true, stage });
      else expect(() => applyFulfilment(st(status), "seller", stage)).toThrowError(expect.objectContaining({ code: "conflict" }));
    });
  }

  it("the buyer can never record a stage (forbidden before any status check)", () => {
    fc.assert(fc.property(statusArb, stageArb, (s, g) => {
      expect(() => applyFulfilment(st(s), "buyer", g)).toThrowError(expect.objectContaining({ code: "forbidden" }));
    }));
  });

  it("rejects unknown stages", () => {
    expect(() => applyFulfilment(st("dispatched"), "seller", "bogus" as never)).toThrowError(expect.objectContaining({ code: "validation" }));
  });

  it("property: an accepted move is strictly forward; a repeat is a no-op; anything lower is a conflict", () => {
    fc.assert(fc.property(statusArb, fc.option(stageArb, { nil: null }), stageArb, (status, cur, next) => {
      const idx = (g: FulfilmentStage | null) => (g ? STAGES.indexOf(g) : -1);
      try {
        const r = applyFulfilment(st(status, cur), "seller", next);
        expect(specOk(status, next)).toBe(true);
        expect(r.changed).toBe(idx(next) > idx(cur));
        expect(idx(next)).toBeGreaterThanOrEqual(idx(cur));
      } catch (e) {
        expect((e as { code: string }).code).toBe("conflict");
        expect(!specOk(status, next) || idx(next) < idx(cur)).toBe(true);
      }
    }));
  });

  it("property: replaying random stage sequences never regresses and never leaves the allowed statuses", () => {
    fc.assert(fc.property(fc.array(stageArb, { maxLength: 12 }), (seq) => {
      let status: Status = "confirmed";
      let cur: FulfilmentStage | null = null;
      let high = -1;
      for (const g of seq) {
        if (g !== "packed" && status === "confirmed") status = "dispatched"; // the seller dispatches (main machine) before later stages
        try {
          const r = applyFulfilment(st(status, cur), "seller", g);
          if (r.changed) cur = r.stage;
        } catch { /* conflict: state unchanged */ }
        const i = cur ? STAGES.indexOf(cur) : -1;
        expect(i).toBeGreaterThanOrEqual(high);
        high = i;
      }
    }));
  });

  it("no stage is accepted once delivered, completed or cancelled, whatever the current stage", () => {
    fc.assert(fc.property(fc.constantFrom<Status>("delivered", "completed", "cancelled"), fc.option(stageArb, { nil: null }), stageArb, (s, cur, g) => {
      expect(() => applyFulfilment(st(s, cur), "seller", g)).toThrowError(expect.objectContaining({ code: "conflict" }));
    }));
  });

  it("availableFulfilmentStages lists exactly the stages a seller could record", () => {
    fc.assert(fc.property(statusArb, fc.option(stageArb, { nil: null }), (status, cur) => {
      const listed = availableFulfilmentStages(st(status, cur), "seller");
      for (const g of STAGES) {
        let ok = true;
        try { ok = applyFulfilment(st(status, cur), "seller", g).changed; } catch { ok = false; }
        expect(listed.includes(g)).toBe(ok);
      }
      expect(availableFulfilmentStages(st(status, cur), "buyer")).toEqual([]);
    }));
    expect(availableFulfilmentStages(st("confirmed"), "seller")).toEqual(["packed"]);
    expect(availableFulfilmentStages(st("dispatched", "in_transit"), "seller")).toEqual(["out_for_delivery", "delivery_attempted"]);
  });

  it("availableActions exposes the same list and leaves the main moves untouched", () => {
    const base = { status: "dispatched" as const, buyerConfirmedAt: new Date(), sellerConfirmedAt: new Date(), fulfilmentStage: "in_transit" as const };
    expect(availableActions(base, "seller").fulfilment).toEqual(["out_for_delivery", "delivery_attempted"]);
    expect(availableActions(base, "buyer").fulfilment).toEqual([]);
    expect(availableActions(base, "buyer").moves).toEqual(["delivered"]);
  });
});

import { trackingSteps } from "../src/fulfilment";
describe("trackingSteps", () => {
  const states = (s: FulfilmentState) => trackingSteps(s).map((x) => x.state);
  it("shows nothing for cancelled orders and all-upcoming before any progress", () => {
    expect(trackingSteps(st("cancelled"))).toEqual([]);
    expect(states(st("confirmed"))).toEqual(["upcoming", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });
  it("marks the latest reached step current and earlier ones done", () => {
    expect(states(st("confirmed", "packed"))).toEqual(["current", "upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(states(st("dispatched"))).toEqual(["done", "current", "upcoming", "upcoming", "upcoming"]);
    expect(states(st("dispatched", "in_transit"))).toEqual(["done", "done", "current", "upcoming", "upcoming"]);
    expect(states(st("dispatched", "delivery_attempted"))).toEqual(["done", "done", "done", "current", "upcoming"]);
    expect(states(st("completed", "packed"))).toEqual(["done", "done", "done", "done", "done"]);
  });
  it("property: at most one current step, never a done step after an upcoming one", () => {
    fc.assert(fc.property(statusArb, fc.option(stageArb, { nil: null }), (status, cur) => {
      const s = trackingSteps(st(status, cur)).map((x) => x.state);
      expect(s.filter((x) => x === "current").length).toBeLessThanOrEqual(1);
      const firstUp = s.indexOf("upcoming");
      if (firstUp >= 0) expect(s.slice(firstUp).every((x) => x === "upcoming")).toBe(true);
    }));
  });
});
