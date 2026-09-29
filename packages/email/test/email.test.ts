import { MemoryJobQueue, setJobQueue } from "@cnote/core";
import { prisma } from "@cnote/db";
import { setConsent } from "@cnote/identity";
import { defineTemplates, seedDefaultTemplates } from "@cnote/templates";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PermanentEmailError, createQueuedMailer, handleEmailSend, maskEmail, sendEmail, sendTestEmail, setEmailProvider, worker, type EmailProvider, type OutgoingEmail } from "../src/index";

const tag = randomUUID().slice(0, 8);
const MKT = `test.promo_${tag}`;
defineTemplates([
  {
    key: MKT, name: "Promo", description: "d", category: "marketing", channels: ["email"], variables: [],
    defaults: { email: { subject: "Deal", body: "<p>Big deal</p>" } },
  },
]);

const sent: OutgoingEmail[] = [];
let behaviour: "ok" | "transient" | "permanent" = "ok";
const provider: EmailProvider = {
  name: "test",
  async send(m) {
    if (behaviour === "transient") throw new Error("smtp timeout");
    if (behaviour === "permanent") throw new PermanentEmailError("mailbox does not exist");
    sent.push(m);
    return { messageId: `t-${sent.length}` };
  },
};

const persons: string[] = [];
const dedupeKeys: string[] = [];
async function person(opts: { erased?: boolean } = {}) {
  const p = await prisma.person.create({ data: { email: `email-test-${randomUUID()}@example.com`, erasedAt: opts.erased ? new Date() : null } });
  persons.push(p.id);
  return p;
}
async function drain(q: MemoryJobQueue) {
  await q.consume("email.send", "email", "t", handleEmailSend);
}

let queue: MemoryJobQueue;
beforeAll(async () => {
  await seedDefaultTemplates();
});
beforeEach(() => {
  queue = new MemoryJobQueue();
  setJobQueue(queue);
  setEmailProvider(provider);
  sent.length = 0;
  behaviour = "ok";
});
afterAll(async () => {
  setJobQueue(undefined);
  setEmailProvider(undefined);
  await prisma.emailMessage.deleteMany({ where: { OR: [{ toPersonId: { in: persons } }, { dedupeKey: { in: dedupeKeys } }, { template: MKT }] } });
  await prisma.consent.deleteMany({ where: { personId: { in: persons } } });
  await prisma.person.deleteMany({ where: { id: { in: persons } } });
});

describe("sendEmail", () => {
  it("masks the address and never stores the body; the job carries the raw address", async () => {
    expect(maskEmail("asha@gmail.com")).toBe("a***@gmail.com");
    const p = await person();
    const id = await sendEmail({ template: "system.test", to: { email: "asha@gmail.com", personId: p.id }, vars: { message: "hi" } });
    expect(id).toBeTruthy();
    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id: id! } });
    expect(row).toMatchObject({ status: "queued", toMasked: "a***@gmail.com", template: "system.test", category: "transactional" });
    expect(JSON.stringify(row)).not.toContain("asha@gmail.com");
    await drain(queue);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "asha@gmail.com", subject: "Test email" });
    expect(sent[0]!.html).toContain("hi");
    const after = await prisma.emailMessage.findUniqueOrThrow({ where: { id: id! } });
    expect(after).toMatchObject({ status: "sent", attempts: 1, provider: "test", providerMessageId: "t-1" });
    expect(after.sentAt).not.toBeNull();
  });

  it("dedupeKey sends at most once", async () => {
    const k = `dk-${randomUUID()}`;
    dedupeKeys.push(k);
    const a = await sendEmail({ template: "system.test", to: { email: "d@example.com" }, vars: { message: "x" }, dedupeKey: k });
    const b = await sendEmail({ template: "system.test", to: { email: "d@example.com" }, vars: { message: "x" }, dedupeKey: k });
    expect(a).toBeTruthy();
    expect(b).toBeNull();
    await drain(queue);
    expect(sent).toHaveLength(1);
  });

  it("suppresses erased recipients and marketing without consent; sends marketing with consent", async () => {
    const erased = await person({ erased: true });
    expect(await sendEmail({ template: "system.test", to: { email: "e@example.com", personId: erased.id }, vars: {} })).toBeNull();
    expect((await prisma.emailMessage.findFirstOrThrow({ where: { toPersonId: erased.id } })).status).toBe("suppressed");

    const p = await person();
    expect(await sendEmail({ template: MKT, to: { email: "m@example.com", personId: p.id }, vars: {} })).toBeNull();
    expect(await sendEmail({ template: MKT, to: { email: "m@example.com" }, vars: {} })).toBeNull(); // anonymous marketing
    await setConsent(p.id, "marketing", true, "test");
    const id = await sendEmail({ template: MKT, to: { email: "m@example.com", personId: p.id }, vars: {} });
    expect(id).toBeTruthy();
    await drain(queue);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).toContain("Unsubscribe");
    expect(sent[0]!.headers?.["List-Unsubscribe"]).toBeTruthy();
    expect(queue).toBeTruthy();
  });

  it("rejects unknown templates and bad addresses", async () => {
    await expect(sendEmail({ template: "nope.nope", to: { email: "a@b.com" }, vars: {} })).rejects.toMatchObject({ code: "validation" });
    await expect(sendEmail({ template: "system.test", to: { email: "not-an-email" }, vars: {} })).rejects.toMatchObject({ code: "validation" });
  });
});

describe("queue consumer", () => {
  it("throws on transient failure (queue retries) and records the error", async () => {
    const id = (await sendEmail({ template: "system.test", to: { email: "t@example.com" }, vars: { message: "x" } }))!;
    behaviour = "transient";
    await drain(queue); // MemoryJobQueue swallows the throw and schedules the retry
    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: "queued", attempts: 1, lastError: "smtp timeout" });
    await expect(handleEmailSend({ id: "m", topic: "email.send", attempt: 1, maxAttempts: 5, enqueuedAt: "", payload: { messageId: id, to: "t@example.com", template: "system.test", vars: { message: "x" } } })).rejects.toThrow("smtp timeout");
    // last attempt marks failed
    await expect(handleEmailSend({ id: "m", topic: "email.send", attempt: 5, maxAttempts: 5, enqueuedAt: "", payload: { messageId: id, to: "t@example.com", template: "system.test", vars: { message: "x" } } })).rejects.toThrow();
    expect((await prisma.emailMessage.findUniqueOrThrow({ where: { id } })).status).toBe("failed");
  });

  it("marks permanent failures failed without retry", async () => {
    const id = (await sendEmail({ template: "system.test", to: { email: "bad@example.com" }, vars: { message: "x" } }))!;
    behaviour = "permanent";
    await handleEmailSend({ id: "m", topic: "email.send", attempt: 1, maxAttempts: 5, enqueuedAt: "", payload: { messageId: id, to: "bad@example.com", template: "system.test", vars: { message: "x" } } });
    expect(await prisma.emailMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "failed", lastError: "mailbox does not exist" });
  });

  it("does not retry when a required variable is missing", async () => {
    const id = (await sendEmail({ template: "auth.password_reset", to: { email: "r@example.com" }, vars: {} }))!;
    await handleEmailSend({ id: "m", topic: "email.send", attempt: 1, maxAttempts: 5, enqueuedAt: "", payload: { messageId: id, to: "r@example.com", template: "auth.password_reset", vars: {} } });
    const row = await prisma.emailMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("failed");
    expect(row.lastError).toContain("resetUrl");
  });

  it("is idempotent for already-sent messages", async () => {
    const id = (await sendEmail({ template: "system.test", to: { email: "i@example.com" }, vars: { message: "x" } }))!;
    await drain(queue);
    await handleEmailSend({ id: "m", topic: "email.send", attempt: 2, maxAttempts: 5, enqueuedAt: "", payload: { messageId: id, to: "i@example.com", template: "system.test", vars: { message: "x" } } });
    expect(sent).toHaveLength(1);
  });

  it("worker exposes the email.send consumer", () => {
    expect(worker.queues?.map((q) => q.topic)).toEqual(["email.send"]);
    expect(worker.queues?.[0]?.concurrency).toBe(2);
  });
});

describe("queued mailer + test sends + console provider", () => {
  it("routes password reset through auth.password_reset", async () => {
    await createQueuedMailer().send({ to: "reset@example.com", subject: "Reset your password", text: "Use this link within 30 minutes:\nhttps://app.example.com/reset-password?token=abc" });
    await drain(queue);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("Reset your password");
    expect(sent[0]!.html).toContain("https://app.example.com/reset-password?token=abc");
    await prisma.emailMessage.deleteMany({ where: { template: "auth.password_reset", toMasked: "r***@example.com" } });
  });

  it("sendTestEmail renders with example variables and prefixes the subject", async () => {
    const res = await sendTestEmail("auth.new_sign_in", "staff@example.com", {});
    expect(res).toMatchObject({ provider: "test" });
    expect(sent[0]!.subject).toBe("[Test] New sign-in to your account");
    expect(sent[0]!.html).toContain("Chrome on Windows");
  });

  it("console provider writes the html preview", async () => {
    setEmailProvider(undefined);
    const id = randomUUID();
    process.env.EMAIL_PROVIDER = "console";
    const { getEmailProvider } = await import("../src/index");
    const res = await getEmailProvider().send({ id, to: "c@example.com", from: "x", subject: "s", html: "<p>preview</p>", text: "t" });
    expect(res.messageId).toMatch(/^console-/);
    const file = new URL(`../../../.data/mail/${id}.html`, import.meta.url).pathname;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("<p>preview</p>");
    setEmailProvider(provider);
  });

  it("stub providers fail loudly", async () => {
    const { createEmailProvider } = await import("../src/index");
    await expect(createEmailProvider("ses").send({ id: "1", to: "a@b.c", from: "x", subject: "s", html: "", text: "" })).rejects.toThrow(/not configured/);
  });
});
