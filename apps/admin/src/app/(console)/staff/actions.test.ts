/* eslint-disable @typescript-eslint/no-unused-vars -- vi.fn signatures declare the call args the assertions read */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resetPasskeys: vi.fn(async (..._a: unknown[]) => 2),
  audited: vi.fn(async (_ctx: unknown, _priv: string, _action: string, _target: unknown, fn: () => Promise<unknown>, _details?: unknown) => fn()),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cnote/identity", async (orig) => ({ ...(await orig<object>()), resetPasskeys: h.resetPasskeys }));
vi.mock("@cnote/admin", async (orig) => ({ ...(await orig<object>()), audited: h.audited }));
vi.mock("@/lib/auth", () => ({ actionContext: async () => ({ staff: { id: "staff-1", personId: "11111111-1111-4111-8111-111111111111" } }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { resetPasskeysAction } from "./actions";

const TARGET = "6f1c0c5e-2a64-4bd8-9a55-0f2a53a3a111";
const form = (o: Record<string, string>) => Object.entries(o).reduce((f, [k, v]) => (f.set(k, v), f), new FormData());

beforeEach(() => {
  h.resetPasskeys.mockClear();
  h.audited.mockClear();
});

describe("resetPasskeysAction (owner-level recovery)", () => {
  it("runs through audited() with the staff.passkeys.reset privilege and the target as subject", async () => {
    const res = await resetPasskeysAction(null, form({ personId: TARGET }));
    expect(res.ok).toBe(true);
    const [, privilege, action, subject, , details] = h.audited.mock.calls[0] as unknown as [unknown, string, string, unknown, unknown, Record<string, unknown>];
    expect(privilege).toBe("staff.passkeys.reset");
    expect(action).toBe("staff.passkeys_reset");
    expect(subject).toEqual({ type: "Person", id: TARGET });
    expect(details).toEqual({ targetPersonId: TARGET });
    expect(h.resetPasskeys).toHaveBeenCalledWith("admin", TARGET, "staff-1");
  });
  it("refuses to reset your own passkeys here and rejects non-UUIDs, without touching the module", async () => {
    const own = await resetPasskeysAction(null, form({ personId: "11111111-1111-4111-8111-111111111111" }));
    expect(own).toMatchObject({ ok: false, error: expect.stringContaining("Security page") });
    expect((await resetPasskeysAction(null, form({ personId: "nope" }))).ok).toBe(false);
    expect(h.audited).not.toHaveBeenCalled();
    expect(h.resetPasskeys).not.toHaveBeenCalled();
  });
  it("propagates a denial from audited() (non-owners)", async () => {
    h.audited.mockRejectedValueOnce(Object.assign(new Error("You don't have permission to do that."), { name: "DomainError" }));
    await expect(resetPasskeysAction(null, form({ personId: TARGET }))).rejects.toThrow("permission");
    expect(h.resetPasskeys).not.toHaveBeenCalled();
  });
});
