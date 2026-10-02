/* eslint-disable @typescript-eslint/no-unused-vars -- vi.fn signatures declare the call args the assertions read */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  moderate: vi.fn(async (..._a: unknown[]) => ({ listingId: "L", before: { status: "flagged" }, after: { status: "approved" } })),
  audited: vi.fn(async (_ctx: unknown, _priv: string, _action: string, _target: unknown, fn: () => Promise<void>) => fn()),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cnote/reviews", () => ({ moderate: h.moderate }));
vi.mock("@cnote/admin", () => ({ audited: h.audited }));
vi.mock("@/lib/auth", () => ({ actionContext: async () => ({ staff: { id: "staff-1" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { moderateAction } from "./actions";

const ID = "6f1c0c5e-2a64-4bd8-9a55-0f2a53a3a111";
const form = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.set(k, v), f), new FormData());

beforeEach(() => {
  h.moderate.mockClear();
  h.audited.mockClear();
});

describe("moderateAction for product Q&A", () => {
  it.each(["question", "answer"])("approves a %s through audited() with the ugc.moderate privilege and a before/after trail", async (kind) => {
    const res = await moderateAction(null, form({ kind, id: ID, decision: "approved" }));
    expect(res.ok).toBe(true);
    expect(h.audited).toHaveBeenCalledTimes(1);
    const [, privilege, action, target, , details] = h.audited.mock.calls[0] as unknown as [unknown, string, string, unknown, unknown, Record<string, unknown>];
    expect(privilege).toBe("ugc.moderate");
    expect(action).toBe(`ugc.${kind}.approved`);
    expect(target).toEqual({ type: `ugc_${kind}`, id: ID });
    expect(h.moderate).toHaveBeenCalledWith(kind, ID, "approved", null, "staff-1");
    expect(details).toMatchObject({ listingId: "L", before: { status: "flagged" }, after: { status: "approved" } });
  });

  it("requires a note to reject and never reaches the module without one", async () => {
    const res = await moderateAction(null, form({ kind: "question", id: ID, decision: "rejected" }));
    expect(res.ok).toBe(false);
    expect(h.moderate).not.toHaveBeenCalled();
    const ok = await moderateAction(null, form({ kind: "question", id: ID, decision: "rejected", note: "Contains a contact number" }));
    expect(ok.ok).toBe(true);
    expect(h.moderate).toHaveBeenCalledWith("question", ID, "rejected", "Contains a contact number", "staff-1");
  });

  it("rejects unknown kinds", async () => {
    expect((await moderateAction(null, form({ kind: "spam", id: ID, decision: "approved" }))).ok).toBe(false);
    expect(h.moderate).not.toHaveBeenCalled();
  });
});
