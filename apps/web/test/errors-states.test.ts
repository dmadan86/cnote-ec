import { describe, expect, it, vi } from "vitest";
import { ERROR_MESSAGE_KEYS } from "../../../packages/next-kit/src/error-catalogue";
import { LOCALES } from "@/i18n/config";
import { loadMessages } from "@/i18n/messages";
import { INDIAN_STATES, STATE_TABLE, stateKey, stateLabel } from "@/features/identity/states";

type Json = { [k: string]: Json | string };
const at = (o: Json, path: string): string | undefined => {
  let cur: Json | string | undefined = o;
  for (const part of path.split(".")) cur = typeof cur === "object" && cur !== null ? cur[part] : undefined;
  return typeof cur === "string" ? cur : undefined;
};

describe("web error catalogue", () => {
  it("every mapped key has a translation in every locale, and English equals the source message", async () => {
    for (const l of LOCALES) {
      const errors = ((await loadMessages(l)) as unknown as Json).errors as Json;
      for (const [message, key] of Object.entries(ERROR_MESSAGE_KEYS)) {
        const text = at(errors, key);
        expect(text, `${l}: errors.${key}`).toBeTruthy();
        if (l === "en" && Object.entries(ERROR_MESSAGE_KEYS).find(([, k]) => k === key)![0] === message) expect(text).toBe(message);
      }
    }
  });
  it("keeps the pre-existing flat errors.* page strings", async () => {
    const errors = ((await loadMessages("hi")) as unknown as Json).errors as Json;
    expect(errors.tryAgain).toBeTruthy();
    expect(errors.auth).toBeTruthy();
  });
});

describe("web states", () => {
  it("every stored state name has a label in every locale", async () => {
    expect(INDIAN_STATES).toHaveLength(36);
    for (const l of LOCALES) {
      const st = ((await loadMessages(l)) as unknown as Json).states as Json;
      for (const s of STATE_TABLE) expect(st[s.code], `${l}.${s.code}`).toBeTruthy();
      if (l === "en") for (const s of STATE_TABLE) expect(st[s.code]).toBe(s.name);
    }
  });
  it("stateLabel translates known names and shows unknown/legacy text as stored", () => {
    const tr = (c: string) => (c === "27" ? "महाराष्ट्र" : undefined);
    expect(stateKey("Maharashtra")).toBe("27");
    expect(stateLabel("Maharashtra", tr)).toBe("महाराष्ट्र");
    expect(stateLabel("Goa", tr)).toBe("Goa");
    expect(stateLabel("Narnia", tr)).toBe("Narnia");
    expect(stateLabel(undefined, tr)).toBe("");
  });
});

describe("localizeActionResult", () => {
  it("swaps the English error for the localized one by key; passes everything else through", async () => {
    vi.doMock("server-only", () => ({}));
    vi.doMock("next-intl/server", () => ({
      getTranslations: async ({ locale }: { locale: string }) => Object.assign((k: string) => `${locale}:${k}`, { has: (k: string) => k === "auth.invalidCredentials" }),
    }));
    const { localizeActionResult } = await import("@/i18n/errors");
    expect(await localizeActionResult({ ok: false, error: "E", errorKey: "auth.invalidCredentials" }, "hi")).toMatchObject({ error: "hi:auth.invalidCredentials" });
    expect(await localizeActionResult({ ok: false, error: "E", errorKey: "auth.invalidCredentials" }, "zz")).toMatchObject({ error: "en:auth.invalidCredentials" });
    expect(await localizeActionResult({ ok: false, error: "E", errorKey: "nope" }, "hi")).toMatchObject({ error: "E" });
    expect(await localizeActionResult({ ok: false, error: "E" })).toEqual({ ok: false, error: "E" });
    expect(await localizeActionResult({ ok: true, data: 1 })).toEqual({ ok: true, data: 1 });
  });
});
