import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { beginMfaEnrollment, confirmMfaEnrollment, disableMfa, mfaStatus, regenerateRecoveryCodes, verifyMfa } from "../src/mfa";
import { base32Decode, totp } from "../src/totp";

const people: string[] = [];
async function newPerson() {
  const p = await prisma.person.create({ data: { email: `mfa-${randomUUID()}@example.test` }, select: { id: true } });
  people.push(p.id);
  return p.id;
}
const secretOf = (uri: string) => base32Decode(new URL(uri).searchParams.get("secret")!);
const codeAt = (secret: Buffer, offsetSteps = 0) => totp(secret, Date.now() + offsetSteps * 30_000);

afterAll(async () => {
  await prisma.personMfa.deleteMany({ where: { personId: { in: people } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
  const keys = await redis.keys(`rl:mfa:verify:*`);
  if (keys.length) await redis.del(...keys);
});

async function enrolled() {
  const id = await newPerson();
  const { otpauthUri, manualKey } = await beginMfaEnrollment(id, "x@example.test");
  const secret = secretOf(otpauthUri);
  expect(manualKey.replace(/ /g, "")).toBe(new URL(otpauthUri).searchParams.get("secret"));
  const { recoveryCodes } = await confirmMfaEnrollment(id, codeAt(secret));
  return { id, secret, recoveryCodes };
}

describe("mfa", () => {
  it("enroll -> confirm -> status, secret encrypted at rest, 10 hashed recovery codes", async () => {
    const id = await newPerson();
    expect(await mfaStatus(id)).toEqual({ enabled: false, enrolling: false, recoveryCodesLeft: 0 });
    const { otpauthUri } = await beginMfaEnrollment(id, "x@example.test");
    expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect((await mfaStatus(id)).enrolling).toBe(true);
    await expect(confirmMfaEnrollment(id, "000000")).rejects.toThrow("incorrect");
    const secret = secretOf(otpauthUri);
    const { recoveryCodes } = await confirmMfaEnrollment(id, codeAt(secret));
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(await mfaStatus(id)).toEqual({ enabled: true, enrolling: false, recoveryCodesLeft: 10 });

    const row = await prisma.personMfa.findUniqueOrThrow({ where: { personId: id } });
    expect(row.totpSecretEnc).toMatch(/^v1\./);
    expect(row.totpSecretEnc).not.toContain(new URL(otpauthUri).searchParams.get("secret")!);
    expect(row.recoveryCodeHashes.join()).not.toContain(recoveryCodes[0]!);
    await expect(beginMfaEnrollment(id, "x")).rejects.toThrow("already enabled");
  });

  it("verifies within ±1 step, rejects replay of the same step and outside the window", async () => {
    const { id, secret } = await enrolled(); // enrollment consumed the current step
    await expect(verifyMfa(id, codeAt(secret))).rejects.toThrow(); // replay of the confirm code
    expect((await verifyMfa(id, codeAt(secret, 1))).method).toBe("totp"); // next step ok
    await expect(verifyMfa(id, codeAt(secret, 1))).rejects.toThrow(); // replay
    await expect(verifyMfa(id, codeAt(secret, 0))).rejects.toThrow(); // older than lastUsedStep
    await expect(verifyMfa(id, codeAt(secret, 5))).rejects.toThrow(); // outside window
  });

  it("recovery codes are single-use", async () => {
    const { id, recoveryCodes } = await enrolled();
    const r = await verifyMfa(id, recoveryCodes[0]!.toUpperCase());
    expect(r).toEqual({ method: "recovery", recoveryCodesLeft: 9 });
    await expect(verifyMfa(id, recoveryCodes[0]!)).rejects.toThrow();
    expect((await mfaStatus(id)).recoveryCodesLeft).toBe(9);
    await expect(verifyMfa(id, "aaaaa-bbbbb")).rejects.toThrow();
  });

  it("concurrent use of one recovery code succeeds exactly once", async () => {
    const { id, recoveryCodes } = await enrolled();
    const results = await Promise.allSettled([verifyMfa(id, recoveryCodes[1]!), verifyMfa(id, recoveryCodes[1]!), verifyMfa(id, recoveryCodes[1]!)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("disable and regenerate require a valid code", async () => {
    const { id, secret, recoveryCodes } = await enrolled();
    await expect(disableMfa(id, "123456")).rejects.toThrow();
    const fresh = await regenerateRecoveryCodes(id, codeAt(secret, 1));
    expect(fresh).toHaveLength(10);
    await expect(verifyMfa(id, recoveryCodes[2]!)).rejects.toThrow(); // old set revoked
    await disableMfa(id, fresh[0]!);
    expect(await mfaStatus(id)).toEqual({ enabled: false, enrolling: false, recoveryCodesLeft: 0 });
  });

  it("rate limits guessing", async () => {
    const { id } = await enrolled();
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, () => verifyMfa(id, "000000")));
    expect(outcomes.some((o) => o.status === "rejected" && String(o.reason).includes("Too many"))).toBe(true);
  });
});
