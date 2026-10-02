import { describe, expect, it } from "vitest";
import { assertLegalEntity, dialable, ENTITY_ENV_KEYS, isLegalEntityStrict, isPlaceholder, legalEntity, missingEntityEnv } from "@/features/legal/entity";

const FULL = {
  PLATFORM_LEGAL_NAME: "Example Commerce Pvt Ltd",
  PLATFORM_CIN: "U74999KA2026PTC000001",
  PLATFORM_GSTIN: "29ABCDE1234F1Z5",
  PLATFORM_ADDRESS: "1 MG Road, Bengaluru 560001",
  SUPPORT_EMAIL: "support@example.in",
  SUPPORT_PHONE: "+91 80 1234 5678",
  SUPPORT_WHATSAPP: "+91 98765 43210",
  SUPPORT_HOURS: "Mon-Sat, 9:00 to 18:00 IST",
};

describe("legal entity config", () => {
  it("reads every detail from env", () => {
    const e = legalEntity({ ...FULL, GRIEVANCE_OFFICER_NAME: "A. Officer", GRIEVANCE_OFFICER_EMAIL: "grievance@example.in" });
    expect(e).toMatchObject({ legalName: FULL.PLATFORM_LEGAL_NAME, cin: FULL.PLATFORM_CIN, gstin: FULL.PLATFORM_GSTIN, address: FULL.PLATFORM_ADDRESS, supportEmail: FULL.SUPPORT_EMAIL, grievanceOfficerEmail: "grievance@example.in" });
    expect(e.missing).toEqual([]);
  });

  it("uses clearly marked placeholders when unset (dev)", () => {
    const e = legalEntity({});
    expect(e.missing).toEqual([...ENTITY_ENV_KEYS]);
    for (const v of [e.legalName, e.cin, e.gstin, e.address, e.supportEmail, e.supportPhone, e.supportWhatsapp, e.supportHours]) expect(isPlaceholder(v)).toBe(true);
    expect(e.grievanceOfficerEmail).toBeNull();
    expect(isPlaceholder("Example Commerce Pvt Ltd")).toBe(false);
  });

  it("treats blank values as unset", () => {
    expect(missingEntityEnv({ ...FULL, PLATFORM_CIN: "   " })).toEqual(["PLATFORM_CIN"]);
  });

  it("production requires every detail and names the unset ones", () => {
    expect(() => assertLegalEntity({ NODE_ENV: "production" })).toThrow(/PLATFORM_CIN/);
    expect(() => assertLegalEntity({ NODE_ENV: "production", ...FULL, SUPPORT_HOURS: "" })).toThrow(/SUPPORT_HOURS/);
    expect(() => assertLegalEntity({ NODE_ENV: "production", ...FULL })).not.toThrow();
  });

  it("never throws outside production", () => {
    expect(() => assertLegalEntity({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertLegalEntity({ NODE_ENV: "test" })).not.toThrow();
  });

  it("strict is the default in production, with an explicit opt-out; never strict elsewhere", () => {
    expect(isLegalEntityStrict({ NODE_ENV: "production" })).toBe(true);
    expect(isLegalEntityStrict({ NODE_ENV: "production", LEGAL_ENTITY_STRICT: "true" })).toBe(true);
    expect(isLegalEntityStrict({ NODE_ENV: "production", LEGAL_ENTITY_STRICT: "" })).toBe(true);
    expect(isLegalEntityStrict({ NODE_ENV: "production", LEGAL_ENTITY_STRICT: "false" })).toBe(false);
    expect(isLegalEntityStrict({ NODE_ENV: "production", LEGAL_ENTITY_STRICT: " FALSE " })).toBe(false);
    expect(isLegalEntityStrict({ NODE_ENV: "development" })).toBe(false);
    expect(isLegalEntityStrict({ NODE_ENV: "test", LEGAL_ENTITY_STRICT: "true" })).toBe(false);
  });

  it("dialable strips formatting for tel: and wa.me links", () => {
    expect(dialable("+91 98765-43210")).toBe("+919876543210");
  });
});
