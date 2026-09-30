import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "@cnote/core";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGE_KEYS, errorKeyFor, FIELD_ERRORS_KEY, localizeError } from "../src/error-catalogue";
import { DEFAULT_MFA_LABELS } from "../src/mfa-labels";

const PACKAGES = join(__dirname, "..", "..");
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules" || f === "test") return [];
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
const corpus = readdirSync(PACKAGES)
  .filter((d) => statSync(join(PACKAGES, d)).isDirectory())
  .flatMap((d) => (statSync(join(PACKAGES, d, "src"), { throwIfNoEntry: false })?.isDirectory() ? sources(join(PACKAGES, d, "src")) : []))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

describe("DomainError key", () => {
  it("is optional and does not change existing constructor calls", () => {
    const e = new DomainError("conflict", "Nope", { a: 1 });
    expect(e.key).toBeUndefined();
    expect(e.message).toBe("Nope");
    expect(e.details).toEqual({ a: 1 });
  });
  it("carries an explicit stable key as the 4th argument", () => {
    expect(new DomainError("conflict", "Nope", undefined, "x.y").key).toBe("x.y");
  });
});

describe("DomainError params", () => {
  it("are optional and carried as the 5th argument", () => {
    expect(new DomainError("validation", "x").params).toBeUndefined();
    expect(new DomainError("validation", "x", undefined, "a.b", { n: 2 }).params).toEqual({ n: 2 });
  });
  it("localizeError passes them to the translator", () => {
    expect(localizeError({ error: "E", errorKey: "a.b", errorParams: { n: 2 } }, (k, p) => `${k}:${p?.n}`)).toBe("a.b:2");
  });
});

describe("errorKeyFor", () => {
  it("prefers the explicit key over the message mapping", () => {
    expect(errorKeyFor(new DomainError("forbidden", "Not signed in.", undefined, "custom.key"))).toBe("custom.key");
  });
  it("maps exact known English messages", () => {
    expect(errorKeyFor(new DomainError("unauthenticated", "Invalid email or password"))).toBe("auth.invalidCredentials");
    expect(errorKeyFor(new DomainError("insufficient_credits", "Not enough lead credits. Top up on the pricing page to accept this lead."))).toBe("credits.insufficient");
  });
  it("returns undefined for unmapped messages", () => expect(errorKeyFor(new DomainError("validation", "Something bespoke"))).toBeUndefined());
  it("maps both escrow-frozen wordings to one key", () => {
    expect(ERROR_MESSAGE_KEYS["Escrow is frozen while a dispute is open."]).toBe(ERROR_MESSAGE_KEYS["This escrow is frozen while a dispute is open."]);
  });
});

describe("ERROR_MESSAGE_KEYS", () => {
  it("has ~100+ entries with unique-format keys (group.name)", () => {
    expect(Object.keys(ERROR_MESSAGE_KEYS).length).toBeGreaterThanOrEqual(100);
    for (const k of Object.values(ERROR_MESSAGE_KEYS)) expect(k).toMatch(/^[a-z][A-Za-z]*\.[A-Za-z]+$/);
  });
  it("every mapped message still exists verbatim in a domain package (guards against copy drift)", () => {
    const missing = Object.keys(ERROR_MESSAGE_KEYS).filter((m) => !corpus.includes(JSON.stringify(m).slice(1, -1)) && !corpus.includes(m));
    expect(missing).toEqual([]);
  });
  it("FIELD_ERRORS_KEY is in the catalogue", () => expect(ERROR_MESSAGE_KEYS["Please fix the highlighted fields."]).toBe(FIELD_ERRORS_KEY));
});

describe("localizeError", () => {
  it("returns the English message without a key", () => expect(localizeError({ error: "E" }, () => "X")).toBe("E"));
  it("uses the translation when present", () => expect(localizeError({ error: "E", errorKey: "a.b" }, (k) => (k === "a.b" ? "T" : undefined))).toBe("T"));
  it("falls back when the key has no translation or the translator throws", () => {
    expect(localizeError({ error: "E", errorKey: "a.b" }, () => undefined)).toBe("E");
    expect(localizeError({ error: "E", errorKey: "a.b" }, () => { throw new Error("no catalogue"); })).toBe("E");
  });
});

describe("MFA labels", () => {
  it("English defaults are complete non-empty strings", () => {
    for (const [k, v] of Object.entries(DEFAULT_MFA_LABELS)) expect(v.trim().length, k).toBeGreaterThan(0);
    expect(DEFAULT_MFA_LABELS.setupKeyIntro).toContain("{key}");
    expect(DEFAULT_MFA_LABELS.setupLinkIntro).toContain("{link}");
    expect(DEFAULT_MFA_LABELS.onNotice).toContain("{count}");
  });
});

describe("fillSlot", () => {
  it("puts the node where the token is, keeping the surrounding words in the translated order", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { fillSlot } = await import("../src/fill-slot");
    expect(renderToStaticMarkup(fillSlot("A {x} B", "x", "<>") as never)).toBe("A &lt;&gt; B");
    expect(renderToStaticMarkup(fillSlot("no token", "x", "N") as never)).toBe("no token");
  });
});
