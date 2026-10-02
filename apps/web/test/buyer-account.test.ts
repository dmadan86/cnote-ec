import { beforeEach, describe, expect, it, vi } from "vitest";
import { INDIAN_STATES } from "@/features/identity/states";
import { stateNameFromPincode } from "@/features/account/pincode-state";

const h = vi.hoisted(() => ({
  session: vi.fn(),
  requireSession: vi.fn(),
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  del: vi.fn(),
  setDefault: vi.fn(),
  verify: vi.fn(),
  rate: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock("@cnote/next-kit", () => ({ currentSession: h.session, requireSession: h.requireSession }));
vi.mock("@cnote/identity", () => ({
  listAddresses: h.list, addAddress: h.add, updateAddress: h.update, deleteAddress: h.del, setDefaultAddress: h.setDefault, verifyGstin: h.verify,
}));
vi.mock("@cnote/core", async (importOriginal) => ({ ...(await importOriginal<typeof import("@cnote/core")>()), rateLimit: h.rate }));
vi.mock("next/cache", () => ({ revalidatePath: h.revalidate }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (k: string) => k }));
vi.mock("@/lib/request-locale", () => ({ getRequestLocale: async () => "en" }));
vi.mock("@/i18n/errors", () => ({
  runLocalized: async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true, data: await fn() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  },
}));

const { GET } = await import("@/app/api/account/addresses/route");
const actions = await import("@/features/account/actions");

const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const BIZ = { business: { id: "biz-1" }, personId: "p-1" };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireSession.mockResolvedValue(BIZ);
  h.rate.mockResolvedValue(true);
  h.del.mockResolvedValue(undefined);
  h.setDefault.mockResolvedValue(undefined);
});

describe("stateNameFromPincode", () => {
  it("derives the canonical state name from the India Post PIN structure", () => {
    expect(stateNameFromPincode("560001")).toBe("Karnataka");
    expect(stateNameFromPincode("110001")).toBe("Delhi");
    expect(stateNameFromPincode("400001")).toBe("Maharashtra");
    expect(stateNameFromPincode("600001")).toBe("Tamil Nadu");
  });
  it("only ever returns names the GST state table knows", () => {
    for (const pin of ["194101", "744101", "682551", "403001", "796001"]) {
      const s = stateNameFromPincode(pin);
      expect(s === null || INDIAN_STATES.includes(s), pin).toBe(true);
    }
  });
  it("is null for malformed pincodes", () => {
    for (const bad of ["", "12345", "abcdef", "012345", "9999999"]) expect(stateNameFromPincode(bad), bad).toBeNull();
  });
});

describe("GET /api/account/addresses", () => {
  it("returns an empty private response when signed out or without a business", async () => {
    h.session.mockResolvedValueOnce(null);
    const r = await GET();
    expect(await r.json()).toEqual({ addresses: [] });
    expect(r.headers.get("cache-control")).toContain("no-store");
    h.session.mockResolvedValueOnce({ business: null });
    expect(await (await GET()).json()).toEqual({ addresses: [] });
    h.session.mockRejectedValueOnce(new Error("boom"));
    expect(await (await GET()).json()).toEqual({ addresses: [] });
    expect(h.list).not.toHaveBeenCalled();
  });
  it("returns only the picker fields of the signed-in business's addresses", async () => {
    h.session.mockResolvedValueOnce(BIZ);
    h.list.mockResolvedValueOnce([{ id: "a1", label: "HQ", city: "Pune", pincode: "411001", isDefault: true, line1: "secret street", phone: "+919999999999", state: "Maharashtra" }]);
    const r = await GET();
    expect(h.list).toHaveBeenCalledWith("biz-1");
    expect(await r.json()).toEqual({ addresses: [{ id: "a1", label: "HQ", city: "Pune", pincode: "411001", isDefault: true }] });
    h.session.mockResolvedValueOnce(BIZ);
    h.list.mockRejectedValueOnce(new Error("db down"));
    expect(await (await GET()).json()).toEqual({ addresses: [] });
  });
});

describe("saveAddressAction", () => {
  const base = { label: "HQ", line1: "12 MG Road", city: "Bengaluru", pincode: "560001" };
  it("derives the state from the pincode, ignoring any state posted by the form", async () => {
    h.add.mockResolvedValueOnce({});
    const r = await actions.saveAddressAction(null, fd({ ...base, state: "Goa" }));
    expect(r.ok).toBe(true);
    expect(h.add).toHaveBeenCalledWith("biz-1", expect.objectContaining({ pincode: "560001", state: "Karnataka" }));
    expect(h.revalidate).toHaveBeenCalledWith("/account/business");
  });
  it("updates when an id is posted", async () => {
    h.update.mockResolvedValueOnce({});
    await actions.saveAddressAction(null, fd({ ...base, id: "a-9", makeDefault: "on" }));
    expect(h.update).toHaveBeenCalledWith("biz-1", "a-9", expect.objectContaining({ makeDefault: true, state: "Karnataka" }));
    expect(h.add).not.toHaveBeenCalled();
  });
  it("reports an unknown pincode on the pincode field, and passes a malformed one on to validation", async () => {
    const r = await actions.saveAddressAction(null, fd({ ...base, pincode: "999999" }));
    expect(r).toMatchObject({ ok: false, fieldErrors: { pincode: "pincodeUnknown" } });
    h.add.mockRejectedValueOnce(new Error("Enter a valid 6-digit pincode."));
    expect(await actions.saveAddressAction(null, fd({ ...base, pincode: "12" }))).toMatchObject({ ok: false });
    expect(h.add).toHaveBeenCalledTimes(1);
  });
  it("needs a business", async () => {
    h.requireSession.mockResolvedValueOnce({ business: null, personId: "p" });
    expect(await actions.saveAddressAction(null, fd(base))).toMatchObject({ ok: false, error: "noBusiness" });
  });
});

describe("delete / default actions", () => {
  it("scope to the session's business and swallow not_found", async () => {
    const { DomainError } = await import("@cnote/core");
    await actions.deleteAddressAction(fd({ id: "a1" }));
    await actions.setDefaultAddressAction(fd({ id: "a2" }));
    expect(h.del).toHaveBeenCalledWith("biz-1", "a1");
    expect(h.setDefault).toHaveBeenCalledWith("biz-1", "a2");
    h.del.mockRejectedValueOnce(new DomainError("not_found", "x"));
    await expect(actions.deleteAddressAction(fd({ id: "gone" }))).resolves.toBeUndefined();
    h.setDefault.mockRejectedValueOnce(new Error("db"));
    await expect(actions.setDefaultAddressAction(fd({ id: "a2" }))).rejects.toThrow("db");
    h.requireSession.mockResolvedValue({ business: null, personId: "p" });
    h.del.mockClear();
    await actions.deleteAddressAction(fd({ id: "a1" }));
    expect(h.del).not.toHaveBeenCalled();
  });
});

describe("verifyBuyerGstinAction", () => {
  it("returns the legal name and state on success", async () => {
    h.verify.mockResolvedValueOnce({ passed: true, tier: 1, legalName: "Acme Pvt Ltd", state: "Karnataka" });
    const r = await actions.verifyBuyerGstinAction(null, fd({ gstin: "29ABCDE1234F1Z5" }));
    expect(h.verify).toHaveBeenCalledWith("biz-1", "29ABCDE1234F1Z5");
    expect(r).toEqual({ ok: true, data: { legalName: "Acme Pvt Ltd", state: "Karnataka" } });
  });
  it("puts a failed verification on the gstin field", async () => {
    h.verify.mockResolvedValueOnce({ passed: false, tier: 0, reason: "GSTIN not found in the GST registry." });
    expect(await actions.verifyBuyerGstinAction(null, fd({ gstin: "x" }))).toMatchObject({ ok: false, fieldErrors: { gstin: "GSTIN not found in the GST registry." } });
    h.verify.mockResolvedValueOnce({ passed: false, tier: 0 });
    expect(await actions.verifyBuyerGstinAction(null, fd({ gstin: "x" }))).toMatchObject({ ok: false, fieldErrors: { gstin: "gstinFailed" } });
  });
  it("rate limits provider lookups per person", async () => {
    h.rate.mockResolvedValueOnce(false);
    expect(await actions.verifyBuyerGstinAction(null, fd({ gstin: "x" }))).toMatchObject({ ok: false, error: expect.stringContaining("Too many") });
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("needs a business", async () => {
    h.requireSession.mockResolvedValueOnce({ business: null, personId: "p" });
    expect(await actions.verifyBuyerGstinAction(null, fd({ gstin: "x" }))).toMatchObject({ ok: false, error: "noBusiness" });
  });
});
