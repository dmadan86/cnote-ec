// Account erasure needs step-up (security audit M10): password, MFA code, or a phone OTP verified within the last 5 minutes.
import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { erasePersonWithStepUp, listPersonBusinessIds, STEP_UP_WINDOW_MS, verifyErasureStepUp } from "../src";
import { beginMfaEnrollment, confirmMfaEnrollment } from "../src/mfa";
import { hashPassword } from "../src/password";
import { base32Decode, totp } from "../src/totp";

const people: string[] = [];
const PASSWORD = "Str0ng-Passw0rd-for-tests!";

async function person(o: { password?: boolean; phoneVerifiedAt?: Date } = {}) {
  const p = await prisma.person.create({
    data: {
      email: `su-${randomUUID()}@example.test`,
      passwordHash: o.password === false ? null : await hashPassword(PASSWORD),
      ...(o.phoneVerifiedAt ? { phone: `+9198${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, phoneVerifiedAt: o.phoneVerifiedAt } : {}),
    },
    select: { id: true },
  });
  people.push(p.id);
  return p.id;
}

afterAll(async () => {
  await prisma.personMfa.deleteMany({ where: { personId: { in: people } } });
  await prisma.consent.deleteMany({ where: { personId: { in: people } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: people } } });
  await prisma.person.deleteMany({ where: { id: { in: people } } });
  const keys = [...(await redis.keys("rl:erase:stepup:*")), ...(await redis.keys("rl:mfa:verify:*"))];
  if (keys.length) await redis.del(...keys);
});

describe("listPersonBusinessIds (export registry context)", () => {
  it("lists the businesses a person belongs to", async () => {
    const id = await person();
    expect(await listPersonBusinessIds(id)).toEqual([]);
    const b = await prisma.business.create({ data: { name: `su-${id}` } });
    await prisma.businessMember.create({ data: { personId: id, businessId: b.id, role: "owner" } });
    expect(await listPersonBusinessIds(id)).toEqual([b.id]);
    await prisma.businessMember.deleteMany({ where: { businessId: b.id } });
    await prisma.business.delete({ where: { id: b.id } });
  });
});

describe("erasePersonWithStepUp", () => {
  it("refuses without proof, and leaves the account untouched", async () => {
    const id = await person();
    await expect(erasePersonWithStepUp(id, {})).rejects.toThrow(/Confirm it's you/);
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
  });

  it("refuses a wrong password, accepts the right one and then erases", async () => {
    const id = await person();
    await expect(erasePersonWithStepUp(id, { password: "nope-not-it-123!" })).rejects.toThrow(/not correct/);
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    await erasePersonWithStepUp(id, { password: PASSWORD });
    const after = await prisma.person.findUniqueOrThrow({ where: { id } });
    expect(after.erasedAt).not.toBeNull();
    expect(after.email).toBeNull();
  });

  it("a phone OTP counts only when verified within the last 5 minutes", async () => {
    const stale = await person({ password: false, phoneVerifiedAt: new Date(Date.now() - STEP_UP_WINDOW_MS - 60_000) });
    await expect(verifyErasureStepUp(stale, {})).rejects.toThrow(/Confirm it's you/);
    const fresh = await person({ password: false, phoneVerifiedAt: new Date(Date.now() - 60_000) });
    expect(await verifyErasureStepUp(fresh, {})).toBe("otp");
    await erasePersonWithStepUp(fresh, {});
    expect((await prisma.person.findUniqueOrThrow({ where: { id: fresh } })).erasedAt).not.toBeNull();
  });

  it("an account with MFA needs the MFA code: the password alone is not enough", async () => {
    const id = await person();
    const { otpauthUri } = await beginMfaEnrollment(id, "x@example.test");
    const secret = base32Decode(new URL(otpauthUri).searchParams.get("secret")!);
    await confirmMfaEnrollment(id, totp(secret, Date.now()));
    await expect(erasePersonWithStepUp(id, { password: PASSWORD })).rejects.toThrow(/authenticator or recovery code/i);
    await expect(erasePersonWithStepUp(id, { mfaCode: "000000" })).rejects.toThrow();
    expect((await prisma.person.findUniqueOrThrow({ where: { id } })).erasedAt).toBeNull();
    // the same TOTP step was consumed during enrolment: use the next step's code
    expect(await verifyErasureStepUp(id, { mfaCode: totp(secret, Date.now() + 30_000) })).toBe("mfa");
  });

  it("rate-limits attempts so the form cannot brute-force the password", async () => {
    const id = await person();
    for (let i = 0; i < 5; i++) await expect(erasePersonWithStepUp(id, { password: "wrong-wrong-1!" })).rejects.toThrow(/not correct/);
    await expect(erasePersonWithStepUp(id, { password: PASSWORD })).rejects.toThrow(/Too many attempts/);
  });
});
