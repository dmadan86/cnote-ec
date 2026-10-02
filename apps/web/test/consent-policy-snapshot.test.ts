import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import hi from "../messages/hi.json";
import { buildSnapshot, hashSnapshot, NOTICE_KEYS, POLICY_SNAPSHOTS, registryHashFor, stableStringify } from "@/features/consent/policy";
import { STORAGE_REGISTRY } from "@/features/consent/registry";
import { CONSENT_POLICY_VERSION } from "@/features/consent/state";

// Proof of WHAT visitors were shown (DPDP s.6(10), EDPB 05/2020). Every CONSENT_POLICY_VERSION has an immutable committed
// snapshot of the storage registry and the en/hi notice + category strings; receipts store its sha256 (`registryHash`).
// This test fails when the live registry or notice strings drift from the snapshot of the CURRENT version.
//
// To change the notice or the registry: bump CONSENT_POLICY_VERSION + CONSENT_POLICY_UPDATED (state.ts), run
//   UPDATE_CONSENT_SNAPSHOT=1 pnpm --filter @cnote/web exec vitest run test/consent-policy-snapshot.test.ts
// to write policy-snapshots/v<N>.json, and register it in POLICY_SNAPSHOTS (policy.ts). Never edit an older snapshot.

const dir = fileURLToPath(new URL("../src/features/consent/policy-snapshots/", import.meta.url));
const file = `${dir}v${CONSENT_POLICY_VERSION}.json`;
const live = buildSnapshot(STORAGE_REGISTRY, { en: en.consent, hi: hi.consent });

// The generator: writes only a MISSING file (snapshots are immutable); "overwrite" is for a version that has not shipped yet.
if (process.env.UPDATE_CONSENT_SNAPSHOT) {
  const body = `${JSON.stringify(JSON.parse(stableStringify(live)), null, 2)}\n`;
  try {
    // "wx" creates atomically and fails if the file exists: no check-then-write race, and an existing snapshot is never replaced.
    writeFileSync(file, body, { flag: process.env.UPDATE_CONSENT_SNAPSHOT === "overwrite" ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

const HOW = `Bump CONSENT_POLICY_VERSION and CONSENT_POLICY_UPDATED in apps/web/src/features/consent/state.ts, then run
  UPDATE_CONSENT_SNAPSHOT=1 pnpm --filter @cnote/web exec vitest run test/consent-policy-snapshot.test.ts
to write policy-snapshots/v<N>.json, and register it in POLICY_SNAPSHOTS (features/consent/policy.ts). Do not edit an older snapshot.`;

describe("consent policy snapshots", () => {
  it(`has a committed snapshot for CONSENT_POLICY_VERSION (v${CONSENT_POLICY_VERSION})`, () => {
    expect(POLICY_SNAPSHOTS[CONSENT_POLICY_VERSION], `No snapshot is registered for policy version ${CONSENT_POLICY_VERSION}.\n${HOW}`).toBeDefined();
    expect(existsSync(file), `policy-snapshots/v${CONSENT_POLICY_VERSION}.json is missing.\n${HOW}`).toBe(true);
  });

  it("the live registry and en/hi notice strings match the snapshot of the current version", () => {
    const snap = POLICY_SNAPSHOTS[CONSENT_POLICY_VERSION];
    const same = stableStringify(snap) === stableStringify(JSON.parse(stableStringify(live)));
    expect(same, `The cookie registry or the notice/category strings changed but policy version ${CONSENT_POLICY_VERSION} did not.\n${HOW}`).toBe(true);
  });

  it("the snapshot hash a receipt stores is the sha256 of the live notice", () => {
    expect(registryHashFor(CONSENT_POLICY_VERSION)).toMatch(/^[a-f0-9]{64}$/);
    expect(registryHashFor(CONSENT_POLICY_VERSION)).toBe(hashSnapshot(JSON.parse(stableStringify(live))));
    expect(registryHashFor(9_999)).toBeNull();
  });

  it("every snapshot file is registered, named after its own version, and the hash ignores key order", () => {
    const files = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f));
    for (const f of files) {
      const n = Number(/^v(\d+)\.json$/.exec(f)![1]);
      const body = JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as { version: number };
      expect(body.version, `${f} must contain version ${n}`).toBe(n);
      expect(POLICY_SNAPSHOTS[n], `${f} is not registered in POLICY_SNAPSHOTS`).toBeDefined();
    }
    expect(hashSnapshot({ a: 1, b: { c: 2, d: 3 } })).toBe(hashSnapshot({ b: { d: 3, c: 2 }, a: 1 }));
  });

  it("covers every notice key in both languages (a missing translation would silently weaken the proof)", () => {
    for (const k of NOTICE_KEYS) {
      expect(en.consent as Record<string, unknown>, `en consent.${k}`).toHaveProperty(k);
      expect(hi.consent as Record<string, unknown>, `hi consent.${k}`).toHaveProperty(k);
    }
  });
});
