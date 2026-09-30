import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ERROR_MESSAGE_KEYS } from "../../../packages/next-kit/src/error-catalogue";
import { DEFAULT_MFA_LABELS } from "../../../packages/next-kit/src/mfa-labels";
import { LOCALES } from "../src/i18n/config";
import { loadMessages } from "../src/i18n/messages";
import { STATE_NAMES, STATE_TABLE, stateKey, stateLabel } from "../src/lib/states";
import { STATES } from "../src/lib/constants";

type Json = { [k: string]: Json | string };
const messages = (l: (typeof LOCALES)[number]) => loadMessages(l);
const at = (o: Json, path: string): string | undefined => {
  let cur: Json | string | undefined = o;
  for (const part of path.split(".")) cur = typeof cur === "object" && cur !== null ? cur[part] : undefined;
  return typeof cur === "string" ? cur : undefined;
};

describe("error catalogue (seller)", () => {
  it("every mapped error key has a translation in every locale (English message = the mapped source message)", async () => {
    for (const l of LOCALES) {
      const m = (await messages(l)) as Json;
      const errors = m.errors as Json;
      for (const [message, key] of Object.entries(ERROR_MESSAGE_KEYS)) {
        const text = at(errors, key);
        expect(text, `${l}: errors.${key}`).toBeTruthy();
        // a key may have several source wordings (aliases); the English catalogue holds the first (canonical) one
        if (l === "en" && Object.entries(ERROR_MESSAGE_KEYS).find(([, k]) => k === key)![0] === message) expect(text, key).toBe(message);
      }
    }
  });
  it("catalogue has no orphan keys (every errors.* key is mapped or documented as explicit-key only)", async () => {
    const en = (await messages("en")).errors as Json;
    const flat = (o: Json, p = ""): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === "string" ? [p + k] : flat(v, `${p}${k}.`)));
    const mapped = new Set(Object.values(ERROR_MESSAGE_KEYS));
    expect(flat(en).filter((k) => !mapped.has(k))).toEqual([]);
  });
});

describe("MFA labels (seller)", () => {
  it("the mfa namespace mirrors DEFAULT_MFA_LABELS in every locale, with the same slots", async () => {
    for (const l of LOCALES) {
      const mfa = ((await messages(l)) as Json).mfa as Json;
      expect(Object.keys(mfa).sort(), l).toEqual(Object.keys(DEFAULT_MFA_LABELS).sort());
      for (const [k, v] of Object.entries(DEFAULT_MFA_LABELS)) {
        const slots = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
        expect(slots(mfa[k] as string), `${l}.${k}`).toEqual(slots(v));
      }
    }
    expect(((await messages("en")) as Json).mfa).toEqual(DEFAULT_MFA_LABELS);
  });
  it("non-English labels are actually translated", async () => {
    const hi = ((await messages("hi")) as Json).mfa as Json;
    expect(hi.verify).not.toBe("Verify");
    expect(hi.title).not.toBe(DEFAULT_MFA_LABELS.title);
  });
});

describe("states (seller)", () => {
  it("covers every GST state/UT stored name plus Other, in the same spelling as identity.GST_STATES", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "packages", "identity", "src", "gstin.ts"), "utf8");
    const block = src.slice(src.indexOf("GST_STATES"), src.indexOf("};", src.indexOf("GST_STATES")));
    const gst = [...block.matchAll(/"(\d{2})": "([^"]+)"/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(gst.length).toBe(36);
    for (const [code, name] of gst) expect(STATE_TABLE.find((s) => s.code === code)?.name, code).toBe(name);
    expect(STATE_NAMES).toContain("Other");
    expect(STATES).toBe(STATE_NAMES);
  });
  it("every locale labels every state; non-English labels are not the English value (except identical proper nouns)", async () => {
    const en = (await messages("en")).states as Json;
    for (const l of LOCALES) {
      const st = ((await messages(l)) as Json).states as Json;
      for (const s of STATE_TABLE) {
        expect(st[s.code], `${l}.${s.code}`).toBeTruthy();
        if (l === "en") expect(st[s.code]).toBe(s.name);
        else expect(st[s.code], `${l}.${s.code}`).not.toBe(en[s.code]);
      }
    }
  });
  it("stateLabel translates stored English names and GST codes, and leaves unknown text alone", () => {
    const tr = (c: string) => (c === "29" ? "ಕರ್ನಾಟಕ" : undefined);
    expect(stateKey("Karnataka")).toBe("29");
    expect(stateKey("  karnataka ")).toBe("29");
    expect(stateKey("29")).toBe("29");
    expect(stateKey("Atlantis")).toBeUndefined();
    expect(stateLabel("Karnataka", tr)).toBe("ಕರ್ನಾಟಕ");
    expect(stateLabel("29", tr)).toBe("ಕರ್ನಾಟಕ");
    expect(stateLabel("Kerala", tr)).toBe("Kerala"); // known state, no translation loaded: stored name
    expect(stateLabel("32", () => undefined)).toBe("Kerala");
    expect(stateLabel("Atlantis", tr)).toBe("Atlantis");
    expect(stateLabel(null, tr)).toBe("");
  });
});

describe("run(): localised action errors", () => {
  it("translates a failed result by its error key and keeps English otherwise", async () => {
    vi.doMock("next-intl/server", () => ({
      getTranslations: async () => Object.assign((k: string) => `T:${k}`, { has: (k: string) => k === "auth.invalidCredentials" }),
    }));
    vi.doMock("next/navigation", () => ({ unstable_rethrow: (e: unknown) => { throw e; } }));
    vi.doMock("@cnote/next-kit", () => ({ runAction: async () => ({ ok: true, data: 1 }) }));
    const { localizeResult } = await import("../src/lib/run");
    expect(await localizeResult({ ok: false, error: "Invalid email or password", errorKey: "auth.invalidCredentials" })).toEqual({ ok: false, error: "T:auth.invalidCredentials", errorKey: "auth.invalidCredentials" });
    expect(await localizeResult({ ok: false, error: "Bespoke", errorKey: "x.unknown" })).toMatchObject({ error: "Bespoke" });
    expect(await localizeResult({ ok: false, error: "No key" })).toEqual({ ok: false, error: "No key" });
    expect(await localizeResult({ ok: true, data: 5 })).toEqual({ ok: true, data: 5 });
  });
});
