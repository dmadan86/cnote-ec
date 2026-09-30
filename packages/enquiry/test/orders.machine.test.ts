import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ORDER_MOVES, TERMINAL_ORDER_STATUSES, applyConfirm, applyMove, availableActions, computeTotalPaise,
  type OrderMove, type OrderRole, type OrderState,
} from "../src/orders";

type Status = OrderState["status"];
const STATUSES: Status[] = ["recorded", "confirmed", "dispatched", "delivered", "completed", "cancelled"];
const MOVES = Object.keys(ORDER_MOVES) as OrderMove[];
const ROLES: OrderRole[] = ["buyer", "seller"];
const T = new Date("2026-01-01T00:00:00Z");
const fresh = (): OrderState => ({ status: "recorded", buyerConfirmedAt: null, sellerConfirmedAt: null });
const at = (status: Status): OrderState => ({ status, buyerConfirmedAt: status === "recorded" ? null : T, sellerConfirmedAt: status === "recorded" ? null : T });

// The specification, written independently of ORDER_MOVES.
const ALLOWED: Record<OrderMove, { from: Status[]; roles: OrderRole[] }> = {
  dispatched: { from: ["confirmed"], roles: ["seller"] },
  delivered: { from: ["dispatched"], roles: ["buyer"] },
  completed: { from: ["delivered"], roles: ["buyer"] },
  cancelled: { from: ["recorded", "confirmed"], roles: ["buyer", "seller"] },
};

describe("order state machine: applyMove", () => {
  for (const to of MOVES) for (const from of STATUSES) for (const role of ROLES) {
    const ok = ALLOWED[to].from.includes(from) && ALLOWED[to].roles.includes(role);
    it(`${role}: ${from} -> ${to} is ${ok ? "allowed" : "rejected"}`, () => {
      if (ok) expect(applyMove(at(from), role, to).status).toBe(to);
      else {
        const roleOk = ALLOWED[to].roles.includes(role); // role is checked before the source status
        expect(() => applyMove(at(from), role, to)).toThrowError(expect.objectContaining({ code: roleOk ? "conflict" : "forbidden" }));
      }
    });
  }

  it("rejects unknown target statuses", () => {
    expect(() => applyMove(at("confirmed"), "seller", "confirmed" as never)).toThrowError(expect.objectContaining({ code: "validation" }));
  });

  it("terminal statuses accept no move at all", () => {
    for (const s of TERMINAL_ORDER_STATUSES) for (const r of ROLES) for (const m of MOVES) expect(() => applyMove(at(s), r, m)).toThrow();
  });
});

describe("order state machine: applyConfirm", () => {
  it("needs both parties; either order of confirmation works", () => {
    for (const [a, b] of [["buyer", "seller"], ["seller", "buyer"]] as const) {
      const one = applyConfirm(fresh(), a, T);
      expect(one.status).toBe("recorded");
      expect(applyConfirm(one, b, T).status).toBe("confirmed");
    }
  });

  it("re-confirming keeps the first timestamp and stays idempotent after the order moved on", () => {
    const one = applyConfirm(fresh(), "buyer", T);
    expect(applyConfirm(one, "buyer", new Date("2027-01-01")).buyerConfirmedAt).toEqual(T);
    expect(applyConfirm(at("dispatched"), "buyer", T).status).toBe("dispatched");
  });

  it("cannot confirm cancelled orders, or confirm for the first time once past recorded", () => {
    expect(() => applyConfirm(at("cancelled"), "buyer", T)).toThrowError(expect.objectContaining({ code: "conflict" }));
    expect(() => applyConfirm({ ...at("dispatched"), sellerConfirmedAt: null }, "seller", T)).toThrow();
  });
});

describe("availableActions", () => {
  it("mirrors the rules", () => {
    expect(availableActions(fresh(), "buyer")).toEqual({ confirm: true, moves: ["cancelled"], fulfilment: [] });
    expect(availableActions(applyConfirm(fresh(), "buyer", T), "buyer").confirm).toBe(false);
    expect(availableActions(at("confirmed"), "seller")).toEqual({ confirm: false, moves: ["dispatched", "cancelled"], fulfilment: ["packed"] });
    expect(availableActions(at("dispatched"), "buyer").moves).toEqual(["delivered"]);
    expect(availableActions(at("delivered"), "seller").moves).toEqual([]);
  });
});

describe("computeTotalPaise", () => {
  it("is bigint-safe past 2^53", () => {
    expect(computeTotalPaise(250_000n, 40)).toBe(10_000_000n);
    expect(computeTotalPaise(9_007_199_254_740_993n, 3)).toBe(27_021_597_764_222_979n);
    expect(computeTotalPaise(null, 3)).toBeNull();
    expect(computeTotalPaise(5n, null)).toBeNull();
  });
});

describe("property: random action sequences never reach an invalid state", () => {
  const action = fc.oneof(
    fc.record({ kind: fc.constant("confirm" as const), role: fc.constantFrom(...ROLES) }),
    fc.record({ kind: fc.constant("move" as const), role: fc.constantFrom(...ROLES), to: fc.constantFrom(...MOVES) }),
  );
  const RANK: Record<Status, number> = { recorded: 0, confirmed: 1, dispatched: 2, delivered: 3, completed: 4, cancelled: 4 };

  it("invariants hold and every accepted step is a spec-allowed edge", () => {
    fc.assert(fc.property(fc.array(action, { maxLength: 40 }), (steps) => {
      let s = fresh();
      for (const a of steps) {
        const before = s;
        try {
          s = a.kind === "confirm" ? applyConfirm(s, a.role, T) : applyMove(s, a.role, a.to);
        } catch {
          expect(s).toBe(before); // a rejected step changes nothing
          continue;
        }
        if (s.status !== before.status) {
          if (a.kind === "move") expect(ALLOWED[a.to].from).toContain(before.status), expect(ALLOWED[a.to].roles).toContain(a.role);
          else expect([before.status, s.status]).toEqual(["recorded", "confirmed"]);
          expect(RANK[s.status]).toBeGreaterThan(RANK[before.status] - (s.status === "cancelled" ? 99 : 0));
        }
        expect(TERMINAL_ORDER_STATUSES.includes(before.status) ? s.status === before.status : true).toBe(true);
        // beyond `recorded` (other than cancellation before confirmation) both parties confirmed
        if (["confirmed", "dispatched", "delivered", "completed"].includes(s.status)) {
          expect(s.buyerConfirmedAt).not.toBeNull();
          expect(s.sellerConfirmedAt).not.toBeNull();
        }
        if (s.status === "recorded") expect(!(s.buyerConfirmedAt && s.sellerConfirmedAt)).toBe(true);
      }
    }), { numRuns: 500 });
  });
});
