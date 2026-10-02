import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import en from "../messages/en.consent.json";
import hi from "../messages/hi.consent.json";
import { buildSellerSnapshot, hashSnapshot, SELLER_NOTICE_KEYS, SELLER_POLICY_SNAPSHOTS, sellerRegistryHashFor, stableStringify } from "@/features/consent/policy";
import { SELLER_POLICY_VERSION } from "@/features/consent/registry";

// Proof of WHAT sellers were shown (DPDP s.6(10), EDPB 05/2020), same mechanism as the buyer web's consent-policy-snapshot test.
// Fails when the live registry or the en/hi notice strings drift from the committed snapshot of the CURRENT version.
//
// To change the notice or the registry: bump SELLER_POLICY_VERSION + SELLER_POLICY_UPDATED (features/consent/registry.ts), run
//   UPDATE_CONSENT_SNAPSHOT=1 pnpm --filter @cnote/seller-app exec vitest run test/consent-policy-snapshot.test.ts
// to write policy-snapshots/v<N>.json, and register it in SELLER_POLICY_SNAPSHOTS (policy.ts). Never edit an older snapshot.

const dir = fileURLToPath(new URL("../src/features/consent/policy-snapshots/", import.meta.url));
const file = `${dir}v${SELLER_POLICY_VERSION}.json`;
const live = buildSellerSnapshot({ en: en.consent, hi: hi.consent });

if (process.env.UPDATE_CONSENT_SNAPSHOT) {
  const body = `${JSON.stringify(JSON.parse(stableStringify(live)), null, 2)}\n`;
  try {
    // "wx" creates atomically and fails if the file exists: an existing snapshot is never replaced ("overwrite" is for an unshipped version).
    writeFileSync(file, body, { flag: process.env.UPDATE_CONSENT_SNAPSHOT === "overwrite" ? "w" : "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

const HOW = `Bump SELLER_POLICY_VERSION and SELLER_POLICY_UPDATED in apps/seller/src/features/consent/registry.ts, then run
  UPDATE_CONSENT_SNAPSHOT=1 pnpm --filter @cnote/seller-app exec vitest run test/consent-policy-snapshot.test.ts
to write policy-snapshots/v<N>.json, and register it in SELLER_POLICY_SNAPSHOTS (features/consent/policy.ts). Do not edit an older snapshot.`;

describe("seller consent policy snapshots", () => {
  it(`has a committed snapshot for SELLER_POLICY_VERSION (v${SELLER_POLICY_VERSION})`, () => {
    expect(SELLER_POLICY_SNAPSHOTS[SELLER_POLICY_VERSION], `No snapshot is registered for policy version ${SELLER_POLICY_VERSION}.\n${HOW}`).toBeDefined();
    expect(existsSync(file), `policy-snapshots/v${SELLER_POLICY_VERSION}.json is missing.\n${HOW}`).toBe(true);
  });

  it("the live registry and en/hi notice strings match the snapshot of the current version", () => {
    const same = stableStringify(SELLER_POLICY_SNAPSHOTS[SELLER_POLICY_VERSION]) === stableStringify(JSON.parse(stableStringify(live)));
    expect(same, `The seller cookie registry or notice strings changed but policy version ${SELLER_POLICY_VERSION} did not.\n${HOW}`).toBe(true);
  });

  it("the hash a receipt stores is the sha256 of the committed snapshot; an unknown version has none", () => {
    expect(sellerRegistryHashFor(SELLER_POLICY_VERSION)).toMatch(/^[a-f0-9]{64}$/);
    expect(sellerRegistryHashFor(SELLER_POLICY_VERSION)).toBe(hashSnapshot(SELLER_POLICY_SNAPSHOTS[SELLER_POLICY_VERSION]));
    expect(sellerRegistryHashFor(9_999)).toBeNull();
  });

  it("every snapshot file is registered and named after its own version", () => {
    for (const f of readdirSync(dir).filter((x) => /^v\d+\.json$/.test(x))) {
      const n = Number(/^v(\d+)\.json$/.exec(f)![1]);
      expect((JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as { version: number }).version, `${f} must contain version ${n}`).toBe(n);
      expect(SELLER_POLICY_SNAPSHOTS[n], `${f} is not registered in SELLER_POLICY_SNAPSHOTS`).toBeDefined();
    }
  });

  it("covers every notice key in both languages", () => {
    for (const k of SELLER_NOTICE_KEYS) {
      expect(en.consent as Record<string, unknown>, `en consent.${k}`).toHaveProperty(k);
      expect(hi.consent as Record<string, unknown>, `hi consent.${k}`).toHaveProperty(k);
    }
  });
});
