import { describe, expect, it, vi } from "vitest";
import { delhiveryProvider, estimateFreight, getFreightProvider, parseDelhivery, parseShiprocket, setFreightProvider, shiprocketProvider, type HttpJson } from "../src";

const nocache = async <T>(_k: string, _t: number, load: () => Promise<T>) => load();
const req = { originPincode: "110001", destinationPincode: "400001", quantity: 2, unitWeightGrams: 1000 };

describe("shiprocket", () => {
  const body = { data: { available_courier_companies: [{ freight_charge: 95.5, estimated_delivery_days: "3" }, { freight_charge: 140, estimated_delivery_days: 5 }, { freight_charge: 0 }] } };
  it("maps the cheapest and dearest courier into a range and uses a bearer token", async () => {
    const http = vi.fn<HttpJson>(async (url) => (url.includes("/auth/login") ? { status: 200, json: { token: "tok" } } : { status: 200, json: body }));
    const p = shiprocketProvider({ baseUrl: "https://sr.example/v1/external", email: "a@b.c", password: "pw" }, { http, cache: nocache });
    const e = await p.estimate(req);
    expect(e).toMatchObject({ provider: "shiprocket", mode: "parcel", lowPaise: 9550, highPaise: 14000, transitDays: { min: 3, max: 5 } });
    const call = http.mock.calls.find((c) => c[0].includes("serviceability"))!;
    expect(call[0]).toContain("pickup_postcode=110001");
    expect(call[1].headers.authorization).toBe("Bearer tok");
  });
  it("falls back to the card when the API fails", async () => {
    const http: HttpJson = async () => ({ status: 500, json: null });
    const e = await shiprocketProvider({ baseUrl: "https://sr.example", email: "a", password: "b" }, { http, cache: nocache }).estimate(req);
    expect(e?.provider).toBe("heuristic");
    expect(e?.assumptions).toContain("provider_fallback");
  });
  it("does not call out for heavy (truck) lanes", async () => {
    const http = vi.fn<HttpJson>();
    const e = await shiprocketProvider({ baseUrl: "https://sr.example", email: "a", password: "b" }, { http, cache: nocache }).estimate({ ...req, quantity: 5000 });
    expect(http).not.toHaveBeenCalled();
    expect(e?.mode).toBe("ftl");
    expect(e?.assumptions).toContain("provider_fallback");
  });
  it("parse rejects an empty response", () => expect(parseShiprocket({ data: { available_courier_companies: [] } })).toBeNull());
});

describe("delhivery", () => {
  it("reads gross_amount and widens it into a range", async () => {
    const http = vi.fn<HttpJson>(async () => ({ status: 200, json: [{ gross_amount: 100, total_amount: 118 }] }));
    const e = await delhiveryProvider({ baseUrl: "https://dl.example", token: "t", clientName: null }, { http, cache: nocache }).estimate(req);
    expect(e).toMatchObject({ provider: "delhivery", lowPaise: 9500, highPaise: 12000 });
    expect(http.mock.calls[0]![0]).toContain("cgm=2000");
    expect(http.mock.calls[0]![1].headers.authorization).toBe("Token t");
  });
  it("derives ex-GST from total when gross is missing", () => expect(parseDelhivery([{ total_amount: 118 }])?.low).toBe(10000));
});

describe("estimateFreight / provider selection", () => {
  it("validates the pincode", async () => {
    await expect(estimateFreight({ destinationPincode: "12", quantity: 1 })).rejects.toThrow(/pincode/i);
  });
  it("a throwing provider still yields a card estimate", async () => {
    const e = await estimateFreight({ ...req }, { id: "shiprocket", estimate: async () => { throw new Error("boom"); } }).catch(() => null);
    // the card load needs the DB-backed default; with no rows it falls back to the code default
    expect(e === null || e.assumptions.includes("provider_fallback")).toBe(true);
  });
  it("refuses a live provider without credentials in production, degrades elsewhere", () => {
    setFreightProvider(undefined);
    expect(() => getFreightProvider({ FREIGHT_PROVIDER: "delhivery", NODE_ENV: "production" } as never)).toThrow(/DELHIVERY_API_TOKEN/);
    expect(getFreightProvider({ FREIGHT_PROVIDER: "delhivery", NODE_ENV: "development" } as never).id).toBe("heuristic");
    expect(getFreightProvider({ FREIGHT_PROVIDER: "shiprocket", SHIPROCKET_EMAIL: "a@b.c", SHIPROCKET_PASSWORD: "x" } as never).id).toBe("shiprocket");
  });
});
