import { randomUUID } from "node:crypto";
import { redis } from "@cnote/core";
import { prisma } from "@cnote/db";
import { afterAll, describe, expect, it } from "vitest";
import { getSession, hashPhone, requestLoginOtp, setOtpSender, verifyLoginOtp, type OtpSender } from "../src";

const phones: string[] = [];
const newPhone = () => {
  const p = `+9190${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
  phones.push(p);
  return p;
};
const sent: { to: string; code: string; channel: string }[] = [];
const capture: OtpSender = { async send(m) { sent.push(m); } };
const ctx = () => ({ ip: `t-${randomUUID()}`, userAgent: "vitest", visitorId: randomUUID() });

afterAll(async () => {
  const people = await prisma.person.findMany({ where: { phone: { in: phones } }, select: { id: true } });
  const ids = people.map((p) => p.id);
  await prisma.authSession.deleteMany({ where: { personId: { in: ids } } });
  await prisma.consent.deleteMany({ where: { personId: { in: ids } } });
  await prisma.domainEvent.deleteMany({ where: { aggregateId: { in: ids } } });
  await prisma.person.deleteMany({ where: { id: { in: ids } } });
  for (const p of phones) for (const k of await redis.keys(`rl:lotp:*:${hashPhone(p)}:*`)) await redis.del(k);
});

describe("phone login", () => {
  it("creates a verified person on first verify and signs in the same person after", async () => {
    setOtpSender(capture);
    const phone = newPhone();
    const r = await requestLoginOtp(phone, ctx(), { channel: "whatsapp" });
    expect(r.channel).toBe("whatsapp");
    expect(r.phoneHash).toBe(hashPhone(phone));
    const code = sent.at(-1)!.code;
    const t = await verifyLoginOtp(phone, code, ctx(), { consents: { matching: true } });
    expect(t.isNew).toBe(true);
    expect((await getSession(t.accessToken))?.phoneVerified).toBe(true);
    // code is single-use
    await expect(verifyLoginOtp(phone, code, ctx())).rejects.toThrow();

    for (const k of await redis.keys(`rl:lotp:cool:${hashPhone(phone)}:*`)) await redis.del(k);
    await requestLoginOtp(phone, ctx());
    const t2 = await verifyLoginOtp(phone, sent.at(-1)!.code, ctx());
    expect(t2.isNew).toBe(false);
    expect(t2.personId).toBe(t.personId);
  });

  it("rejects a wrong code and locks after too many attempts", async () => {
    setOtpSender(capture);
    const phone = newPhone();
    await requestLoginOtp(phone, ctx());
    const real = sent.at(-1)!.code;
    const wrong = real === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await expect(verifyLoginOtp(phone, wrong, ctx())).rejects.toThrow();
    await expect(verifyLoginOtp(phone, real, ctx())).rejects.toThrow(/Too many/);
  });

  it("rate limits repeated requests for one phone and normalises 10-digit numbers", async () => {
    setOtpSender(capture);
    const phone = newPhone();
    await requestLoginOtp(phone.slice(3), ctx());
    expect(sent.at(-1)!.to).toBe(phone);
    await expect(requestLoginOtp(phone, ctx())).rejects.toThrow(/wait/);
  });
});
