import { describe, expect, it } from "vitest";
import { ALL_CATEGORIES, categoriesOf, clientClearable, entriesOf, firstParty, optionalEntries, serverClearable, stripCookiePrefix, type StorageEntry } from "../src";

const REG: readonly StorageEntry[] = [
  firstParty("app_consent", "necessary", "cookie", "consent", { unit: "months", n: 12 }),
  firstParty("app_at", "necessary", "cookie", "auth", { unit: "minutes", n: 15 }, true),
  firstParty("app_t0", "analytics", "cookie", "timing", { unit: "years", n: 1 }, true),
  firstParty("app_pref", "functional", "localStorage", "pref", { unit: "persistent" }),
  { ...firstParty("app_vid", "marketing", "cookie", "visitor", { unit: "days", n: 30 }), alsoServerSet: true },
  firstParty("app_attr", "marketing", "sessionStorage", "attr", { unit: "session" }),
];

describe("registry helpers take the app's registry", () => {
  it("lists entries per category and the categories an app actually has (necessary always first)", () => {
    expect(ALL_CATEGORIES).toEqual(["necessary", "analytics", "marketing", "functional"]);
    expect(entriesOf(REG, "marketing").map((e) => e.name)).toEqual(["app_vid", "app_attr"]);
    expect(categoriesOf(REG)).toEqual(["necessary", "analytics", "marketing", "functional"]);
    const onlyNecessary = REG.filter((e) => e.category === "necessary");
    expect(categoriesOf(onlyNecessary)).toEqual(["necessary"]);
    expect(categoriesOf(REG.filter((e) => e.category !== "functional"))).toEqual(["necessary", "analytics", "marketing"]);
    expect(categoriesOf([])).toEqual(["necessary"]);
  });
  it("splits what the browser can delete from what only the server can", () => {
    expect(clientClearable(REG, "analytics")).toEqual([]); // httpOnly: the server expires it
    expect(serverClearable(REG, "analytics").map((e) => e.name)).toEqual(["app_t0"]);
    expect(clientClearable(REG, "marketing").map((e) => e.name)).toEqual(["app_vid", "app_attr"]);
    expect(serverClearable(REG, "marketing").map((e) => e.name)).toEqual(["app_vid"]); // client-written twin the server also expires
    expect(clientClearable(REG, "functional").map((e) => e.name)).toEqual(["app_pref"]);
    expect(serverClearable(REG, "functional")).toEqual([]);
  });
  it("optionalEntries is what a necessary-only app's test asserts to be empty", () => {
    expect(optionalEntries(REG).map((e) => e.name)).toEqual(["app_t0", "app_pref", "app_vid", "app_attr"]);
    expect(optionalEntries(REG.filter((e) => e.category === "necessary"))).toEqual([]);
  });
  it("strips the production __Host- / __Secure- prefix so a cookie matches its registry entry", () => {
    expect(stripCookiePrefix("__Host-cnote_seller_at")).toBe("cnote_seller_at");
    expect(stripCookiePrefix("__Secure-x")).toBe("x");
    expect(stripCookiePrefix("seller_locale")).toBe("seller_locale");
  });
});
